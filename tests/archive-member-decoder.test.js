import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tracked = vi.hoisted(() => ({ workers: [], handles: [] }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal();
  class TrackedWorker extends actual.Worker {
    constructor(...args) {
      super(...args);
      tracked.workers.push(this);
    }
  }
  return { ...actual, Worker: TrackedWorker };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: async (...args) => {
      const handle = await actual.open(...args);
      tracked.handles.push(handle);
      return handle;
    },
  };
});

const {
  ArchiveDecoderError,
  extractArchiveMember,
  listArchiveEntries,
  runDecoderJob,
} = await import('../src/services/archive-member-decoder.js');
const { interpretListing } = await import('../src/services/archive-member-listing.js');
const { Worker } = await import('node:worker_threads');

const FIXTURES = fileURLToPath(new URL('./fixtures/archive-decoder/', import.meta.url));
const VENDOR = fileURLToPath(new URL('../vendor/7zip-wasm/', import.meta.url));
const WORKER_URL = new URL('../src/services/archive-member-decoder-worker.js', import.meta.url);
const fixture = (name) => path.join(FIXTURES, name);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const MIB = 1024 * 1024;

async function expectCode(promise, code) {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(ArchiveDecoderError);
  expect(error.code).toBe(code);
  return error;
}

function expectAllReleased() {
  expect(tracked.workers.length).toBeGreaterThan(0);
  for (const worker of tracked.workers) expect(worker.threadId).toBe(-1);
  for (const handle of tracked.handles) expect(handle.fd).toBe(-1);
}

// Builds a 7z archive in the vendored 7-Zip's in-memory filesystem, so names that a host
// filesystem cannot hold (control characters, very deep paths) are possible. renames are
// [stored, final] pairs applied with `7zz rn`, which accepts any path without directory entries.
async function make7z(files, renames = []) {
  const SevenZip = createRequire(import.meta.url)(path.join(VENDOR, '7zz.cjs'));
  const log = [];
  const module = await SevenZip({
    noInitialRun: true,
    print: (line) => log.push(line),
    printErr: (line) => log.push(line),
    wasmBinary: fs.readFileSync(path.join(VENDOR, '7zz.wasm')),
  });
  module.FS.mkdir('/w');
  module.FS.chdir('/w');
  for (const [name, data] of files) module.FS.writeFile(name, data);
  const switches = ['-mhc=off', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-bsp0', '-y'];
  const run = (args) => {
    if (module.callMain(args) !== 0) throw new Error('7zz ' + args[0] + ' failed:\n' + log.join('\n'));
  };
  run(['a', '-t7z', ...switches, '/out.7z', ...files.map(([name]) => name)]);
  if (renames.length > 0) {
    module.FS.writeFile('/renames.txt', renames.flat().join('\n') + '\n');
    run(['rn', ...switches, '-scsUTF-8', '/out.7z', '@/renames.txt']);
  }
  return Buffer.from(module.FS.readFile('/out.7z'));
}

// 600 distinct, valid paths of ~1022 characters and ~509 segments each, as in the review.
const DEEP_ENTRY_COUNT = 600;
function deepPath(index, maxLength = 1024) {
  let value = 'e' + index + '/';
  while (value.length + 'd/f.bin'.length <= maxLength) value += 'd/';
  return value + 'f.bin';
}

let tempDir;
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-archive-decoder-'));
});
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
beforeEach(() => {
  tracked.workers.length = 0;
  tracked.handles.length = 0;
});

describe('vendored 7-Zip 26.06 artifact', () => {
  it('matches the recorded checksums', () => {
    const sums = fs.readFileSync(path.join(VENDOR, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(2);
    for (const line of sums) {
      const [hash, name] = line.split(/\s+\*?/);
      expect(sha256(fs.readFileSync(path.join(VENDOR, name)))).toBe(hash);
    }
  });
});

describe('RAR decoding', () => {
  it('lists and extracts compressed RAR4 members, keeping links unusable', async () => {
    const listing = await listArchiveEntries(fixture('rar4-compressed.rar'), { format: 'rar' });
    expect(listing.format).toBe('rar4');
    expect(listing.entries.map(({ path: p, type }) => [p, type])).toEqual([
      ['LibarchiveAddingTest.html', 'file'],
      ['testlink', 'unsupported'],
      ['testdir/test.txt', 'file'],
      ['testdir/LibarchiveAddingTest.html', 'file'],
      ['testdir', 'directory'],
      ['testemptydir', 'directory'],
    ]);
    expect(listing.entries[2]).toMatchObject({ index: 2, size: 20, packedSize: 30, crc32: 0xbec8a242 });

    const nested = await extractArchiveMember(fixture('rar4-compressed.rar'), 'testdir/test.txt', { format: 'rar' });
    expect(sha256(nested.data)).toBe('5a5f16e01faf8adf92eb4499a2d3e93010c4b41dbb7f698f4a8466d9f58e6dd2');
    const html = await extractArchiveMember(fixture('rar4-compressed.rar'), 'LibarchiveAddingTest.html', { format: 'rar' });
    expect(html.data.length).toBe(20111);
    expect(sha256(html.data)).toBe('ee16390e87152d7dec632ae2b37566da6135966e46b5166e6f40a1c827fa61ad');

    await expectCode(extractArchiveMember(fixture('rar4-compressed.rar'), 'testlink', { format: 'rar' }), 'MEMBER_NOT_FOUND');
    await expectCode(extractArchiveMember(fixture('rar4-compressed.rar'), 'testdir', { format: 'rar' }), 'MEMBER_NOT_FOUND');
  });

  it('extracts compressed RAR5 and the last member of a solid RAR5', async () => {
    const compressed = await extractArchiveMember(fixture('rar5-compressed.rar'), 'test.bin', { format: 'rar' });
    expect(compressed.format).toBe('rar5');
    expect(sha256(compressed.data)).toBe('588870a2dade35c2650fbb7898c9a9c7f21fce7c281198604e8d0c9737f2c375');

    const listing = await listArchiveEntries(fixture('rar5-solid.rar'), { format: 'rar' });
    expect(listing.solid).toBe(true);
    expect(listing.entries.map((entry) => entry.path)).toEqual(['test1.bin', 'test2.bin', 'test3.bin', 'test4.bin']);
    const last = await extractArchiveMember(fixture('rar5-solid.rar'), 'test4.bin', { format: 'rar' });
    expect(sha256(last.data)).toBe('2627f40180217252956edb9a426e8d3e344adaf89019d3bccbe04f6c3416dcdd');
    const first = await extractArchiveMember(fixture('rar5-solid.rar'), 'test1.bin', { format: 'rar' });
    expect(sha256(first.data)).toBe('7d89f86f9f69d744ffff3fc043e15bf89fc3ffc134ffcbb31d164a99bb8b67b0');
  });

  it('relies on the decoder integrity check when RAR5 stores BLAKE2 instead of CRC32', async () => {
    const result = await extractArchiveMember(fixture('rar5-blake2.rar'), 'cebula.txt', { format: 'rar' });
    expect(result.entry.crc32).toBeNull();
    expect(result.data.length).toBe(814);
  });

  it('rejects encrypted and multi-volume RAR archives', async () => {
    await expectCode(listArchiveEntries(fixture('rar5-encrypted.rar'), { format: 'rar' }), 'ARCHIVE_ENCRYPTED');
    await expectCode(listArchiveEntries(fixture('rar4-header-encrypted.rar'), { format: 'rar' }), 'ARCHIVE_ENCRYPTED');
    await expectCode(listArchiveEntries(fixture('rar5-multivolume.part01.rar'), { format: 'rar' }), 'ARCHIVE_MULTIVOLUME');
    await expectCode(
      extractArchiveMember(fixture('rar4-multivolume.part1.rar'), 'LibarchiveAddingTest.html', { format: 'rar' }),
      'ARCHIVE_MULTIVOLUME',
    );
  });

  it('lists RAR5 symlinks as unsupported entries that cannot be extracted', async () => {
    const listing = await listArchiveEntries(fixture('rar5-symlink.rar'), { format: 'rar' });
    expect(listing.entries.find((entry) => entry.path === 'symlink.txt').type).toBe('unsupported');
    await expectCode(extractArchiveMember(fixture('rar5-symlink.rar'), 'symlink.txt', { format: 'rar' }), 'MEMBER_NOT_FOUND');
  });
});

describe('7z decoding', () => {
  const PAGES = {
    'book/page-01.bin': '3117533e68a0c452cc86f685186b86bccd88200b4b59619e5f5da04f4b5c4fb0',
    'book/page-04.bin': 'a0fe0798c5daafbff74413848ea3449add551d85bf19b6abe76bc90bf253b56d',
  };

  it.each([
    ['pages-solid.7z', true],
    ['pages-nonsolid.7z', false],
  ])('lists and extracts first and last members of %s', async (name, solid) => {
    const listing = await listArchiveEntries(fixture(name), { format: '7z' });
    expect(listing).toMatchObject({ format: '7z', solid });
    expect(listing.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path))
      .toEqual(['book/page-01.bin', 'book/page-02.bin', 'book/page-03.bin', 'book/page-04.bin']);
    for (const [member, hash] of Object.entries(PAGES)) {
      const result = await extractArchiveMember(fixture(name), member, { format: '7z' });
      expect(result.entry.path).toBe(member);
      expect(sha256(result.data)).toBe(hash);
    }
  });

  it('selects members literally and case-sensitively', async () => {
    for (const member of ['book/page-0?.bin', 'book/*.bin', 'BOOK/page-01.bin', 'page-01.bin', 'book']) {
      await expectCode(extractArchiveMember(fixture('pages-solid.7z'), member, { format: '7z' }), 'MEMBER_NOT_FOUND');
    }
    await expectCode(extractArchiveMember(fixture('pages-solid.7z'), '../book/page-01.bin', { format: '7z' }), 'ARCHIVE_ENTRY_UNSAFE');
  });

  it('can run concurrent jobs in separate workers', async () => {
    const results = await Promise.all([
      extractArchiveMember(fixture('pages-solid.7z'), 'book/page-04.bin', { format: '7z' }),
      extractArchiveMember(fixture('rar5-solid.rar'), 'test4.bin', { format: 'rar' }),
    ]);
    expect(sha256(results[0].data)).toBe(PAGES['book/page-04.bin']);
    expect(results[1].data.length).toBe(4096);
    expectAllReleased();
  });
});

describe('resource limits', () => {
  const ZEROS_SHA256 = '83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302';

  it('enforces the WebAssembly memory cap and succeeds within a sufficient cap', async () => {
    await expectCode(extractArchiveMember(fixture('large-dictionary.7z'), 'zeros.bin', {
      format: '7z',
      limits: { maxMemoryBytes: 32 * MIB, maxMemberBytes: 32 * MIB },
    }), 'MEMORY_LIMIT_EXCEEDED');
    expectAllReleased();

    const result = await extractArchiveMember(fixture('large-dictionary.7z'), 'zeros.bin', {
      format: '7z',
      limits: { maxMemoryBytes: 64 * MIB, maxMemberBytes: 32 * MIB },
    });
    expect(sha256(result.data)).toBe(ZEROS_SHA256);
  });

  it('refuses members whose declared size exceeds the output cap before decoding', async () => {
    await expectCode(extractArchiveMember(fixture('large-dictionary.7z'), 'zeros.bin', {
      format: '7z',
      limits: { maxMemberBytes: MIB },
    }), 'MEMBER_LIMIT_EXCEEDED');
  });

  it('bounds listing bytes, entry count and input size', async () => {
    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: 'rar', limits: { maxListingBytes: 256 } }), 'LISTING_LIMIT_EXCEEDED');
    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: 'rar', limits: { maxEntries: 3 } }), 'ENTRY_LIMIT_EXCEEDED');
    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: 'rar', limits: { maxInputBytes: 600 } }), 'INPUT_LIMIT_EXCEEDED');
    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: 'rar', limits: { maxMemoryBytes: 8 * MIB } }), 'INVALID_ARGUMENT');
    expectAllReleased();
  });

  it('times out and cancels running jobs, then releases the worker and descriptor', async () => {
    const options = { format: '7z', limits: { maxMemberBytes: 32 * MIB } };
    await expectCode(extractArchiveMember(fixture('large-dictionary.7z'), 'zeros.bin', {
      ...options,
      limits: { ...options.limits, timeoutMs: 40 },
    }), 'TIMEOUT');
    expectAllReleased();

    tracked.workers.length = 0;
    tracked.handles.length = 0;
    const controller = new AbortController();
    const pending = extractArchiveMember(fixture('large-dictionary.7z'), 'zeros.bin', { ...options, signal: controller.signal });
    // Abort while the job's worker is live (the whole job takes well over 100ms).
    const poll = setInterval(() => {
      if (tracked.workers.length > 0) {
        clearInterval(poll);
        setTimeout(() => controller.abort(), 20);
      }
    }, 1);
    await expectCode(pending, 'CANCELLED');
    expectAllReleased();

    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: 'rar', signal: AbortSignal.abort() }), 'CANCELLED');
  });
});

describe('worker protocol', () => {
  let wasmModule;
  beforeAll(async () => {
    wasmModule = await WebAssembly.compile(fs.readFileSync(path.join(VENDOR, '7zz.wasm')));
  });

  // Drives the real worker directly so tests can observe what the decoder itself reported.
  async function startWorker(name, archiveType, limits) {
    const handle = await fs.promises.open(fixture(name), 'r');
    const { size } = await handle.stat();
    const worker = new Worker(WORKER_URL, {
      workerData: {
        gluePath: path.join(VENDOR, '7zz.cjs'),
        wasmModule,
        fd: handle.fd,
        inputSize: size,
        archiveType,
        limits: { maxMemoryBytes: 64 * MIB, maxMemberBytes: 64 * MIB, maxListingBytes: MIB, maxLogBytes: 65536, ...limits },
      },
    });
    const messages = [];
    const waiters = [];
    worker.on('message', (message) => {
      messages.push(message);
      waiters.splice(0).forEach((wake) => wake());
    });
    const next = async (type) => {
      for (;;) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => waiters.push(resolve));
      }
    };
    const stop = async () => {
      await worker.terminate();
      await handle.close();
    };
    return { messages, next, worker, stop };
  }

  it('latches a listing-cap failure even though 7-Zip itself exits with 0', async () => {
    const job = await startWorker('pages-solid.7z', '7z', { maxListingBytes: 300 });
    try {
      const aborted = await job.next('aborted');
      expect(job.messages[0]).toMatchObject({ type: 'failed', code: 'LISTING_LIMIT_EXCEEDED' });
      expect(aborted.exitCode).toBe(0);
      expect(job.messages.some((message) => message.type === 'listed')).toBe(false);
    } finally {
      await job.stop();
    }
  });

  it('stops output that exceeds the size the parent permitted', async () => {
    const job = await startWorker('rar5-solid.rar', 'Rar5', {});
    try {
      await job.next('listed');
      job.worker.postMessage({ type: 'extract', member: 'test4.bin', size: 1000 });
      const failed = await job.next('failed');
      expect(failed.code).toBe('OUTPUT_LIMIT_EXCEEDED');
      await job.next('aborted');
      expect(job.messages.some((message) => message.type === 'extracted')).toBe(false);
    } finally {
      await job.stop();
    }
  });

  const LISTING = [
    '', '7-Zip (z) 26.06', '', 'Listing archive: /in/archive', '', '--',
    'Path = /in/archive', 'Type = 7z', 'Physical Size = 100', 'Solid = -', '', '----------',
    'Path = a.bin', 'Size = 3', 'Packed Size = 3', 'Attributes = A', 'CRC = 352441C2', '', '',
  ].join('\n');
  const context = { expectedType: '7z', inputSize: 100, maxEntries: 10, maxPathLength: 1024 };
  const limits = { timeoutMs: 1000, maxMemberBytes: 1024 };

  function fakeWorker() {
    const worker = new EventEmitter();
    worker.postMessage = vi.fn();
    return worker;
  }

  it('fails when a latch arrives before an otherwise valid exit-0 listing', async () => {
    const worker = fakeWorker();
    const job = runDecoderJob(worker, { context, limits });
    worker.emit('message', { type: 'failed', code: 'LOG_LIMIT_EXCEEDED', message: 'cap' });
    worker.emit('message', { type: 'listed', exitCode: 0, stdout: new TextEncoder().encode(LISTING), stderr: '' });
    await expectCode(job, 'LOG_LIMIT_EXCEEDED');
  });

  const selected = (text = LISTING) => ({ exitCode: 0, stdout: new TextEncoder().encode(text), stderr: '' });

  it('accepts only complete, CRC-valid member output', async () => {
    const run = async (extracted) => {
      const worker = fakeWorker();
      const job = runDecoderJob(worker, { context, limits, memberPath: 'a.bin' });
      worker.emit('message', { type: 'listed', exitCode: 0, stdout: new TextEncoder().encode(LISTING), stderr: '' });
      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'extract', member: 'a.bin', size: 3 });
      worker.emit('message', { type: 'extracted', stderr: '', selection: selected(), ...extracted });
      return job;
    };
    const ok = await run({ exitCode: 0, length: 3, output: new TextEncoder().encode('abc') });
    expect(ok.data.toString()).toBe('abc');
    await expectCode(run({ exitCode: 0, length: 3, output: new TextEncoder().encode('abd') }), 'EXTRACTION_FAILED');
    await expectCode(run({ exitCode: 0, length: 2, output: new TextEncoder().encode('ab') }), 'EXTRACTION_FAILED');
    await expectCode(run({ exitCode: 2, length: 3, output: new TextEncoder().encode('abc') }), 'EXTRACTION_FAILED');
    await expectCode(run({ exitCode: 0, length: 3, output: new TextEncoder().encode('abc'), stderr: 'ERROR: Data Error' }), 'EXTRACTION_FAILED');
  });

  it('checks output length when the archive has no CRC32 for the member', async () => {
    const worker = fakeWorker();
    const job = runDecoderJob(worker, { context, limits, memberPath: 'a.bin' });
    const noCrc = LISTING.replace('CRC = 352441C2', 'CRC = ');
    worker.emit('message', { type: 'listed', exitCode: 0, stdout: new TextEncoder().encode(noCrc), stderr: '' });
    // The worker preallocates the declared size; only `length` says how much was written.
    worker.emit('message', {
      type: 'extracted', exitCode: 0, stderr: '', length: 2, output: new Uint8Array([97, 98, 0]), selection: selected(noCrc),
    });
    await expectCode(job, 'EXTRACTION_FAILED');
  });

  it('refuses output unless the extraction selector picks exactly the listed member', async () => {
    const run = async (selection) => {
      const worker = fakeWorker();
      const job = runDecoderJob(worker, { context, limits, memberPath: 'a.bin' });
      worker.emit('message', { type: 'listed', exitCode: 0, stdout: new TextEncoder().encode(LISTING), stderr: '' });
      // The output itself is complete and CRC-valid; only the selection proof differs.
      worker.emit('message', { type: 'extracted', exitCode: 0, stderr: '', length: 3, output: new TextEncoder().encode('abc'), selection });
      return job;
    };
    const nothing = LISTING.slice(0, LISTING.indexOf('Path = a.bin'));
    await expectCode(run(selected(nothing)), 'EXTRACTION_FAILED');
    await expectCode(run(selected(LISTING.replace('Size = 3', 'Size = 4'))), 'EXTRACTION_FAILED');
    await expectCode(run(selected(LISTING.replace('a.bin', 'b.bin'))), 'EXTRACTION_FAILED');
    await expectCode(run(selected(LISTING + 'Path = a.bin/x\nSize = 1\nAttributes = A\n\n')), 'ARCHIVE_ENTRY_AMBIGUOUS');
    await expectCode(run({ ...selected(), exitCode: 2 }), 'ARCHIVE_CORRUPT');
    await expectCode(run(undefined), 'PROTOCOL_ERROR');
    expect((await run(selected())).data.toString()).toBe('abc');
  });

  describe('deadline and cancellation during parent-side validation', () => {
    const listed = (text) => ({ type: 'listed', exitCode: 0, stdout: new TextEncoder().encode(text), stderr: '' });
    let clock;
    let now;
    beforeEach(() => {
      clock = 0;
      now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    });
    afterEach(() => now.mockRestore());

    it('returns TIMEOUT, not success or a parse error, once the deadline has passed', async () => {
      for (const text of [LISTING, 'not a listing']) {
        clock = 0;
        const worker = fakeWorker();
        const job = runDecoderJob(worker, { context, limits });
        clock = limits.timeoutMs;
        worker.emit('message', listed(text));
        await expectCode(job, 'TIMEOUT');
      }

      clock = 0;
      const worker = fakeWorker();
      const job = runDecoderJob(worker, { context, limits, memberPath: 'a.bin' });
      worker.emit('message', listed(LISTING));
      clock = limits.timeoutMs + 1;
      worker.emit('message', { type: 'extracted', exitCode: 0, stderr: '', length: 3, output: new TextEncoder().encode('abc'), selection: selected() });
      await expectCode(job, 'TIMEOUT');
    });

    it('stops a long validation at the deadline instead of finishing it', async () => {
      const records = Array.from({ length: DEEP_ENTRY_COUNT }, (_, index) => ['Path = ' + deepPath(index), 'Size = 0', 'Attributes = A', '']);
      const text = LISTING.slice(0, LISTING.indexOf('Path = a.bin')) + records.flat().join('\n') + '\n';
      let reads = 0;
      now.mockImplementation(() => {
        reads += 1;
        return reads > 10 ? limits.timeoutMs : 0;
      });
      const worker = fakeWorker();
      const job = runDecoderJob(worker, { context: { ...context, maxEntries: 1000 }, limits });
      worker.emit('message', listed(text));
      await expectCode(job, 'TIMEOUT');
      // One clock read per record: validation stopped long before all 600 records were checked.
      expect(reads).toBeLessThan(20);
    });

    it('returns CANCELLED when the job is aborted while validation runs', async () => {
      // An abort that lands during synchronous validation is only visible through `aborted`.
      const signal = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      const worker = fakeWorker();
      const job = runDecoderJob(worker, { context, limits, signal });
      signal.aborted = true;
      worker.emit('message', listed(LISTING));
      await expectCode(job, 'CANCELLED');
      expect(signal.removeEventListener).toHaveBeenCalled();
    });
  });

  it('treats worker errors, early exits and unexpected messages as failures', async () => {
    const cases = [
      [(worker) => worker.emit('error', new Error('boom')), 'DECODER_FAILED'],
      [(worker) => worker.emit('error', Object.assign(new Error('oom'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })), 'MEMORY_LIMIT_EXCEEDED'],
      [(worker) => worker.emit('exit', 0), 'DECODER_FAILED'],
      [(worker) => worker.emit('message', { type: 'extracted', exitCode: 0 }), 'PROTOCOL_ERROR'],
      [(worker) => worker.emit('message', { type: 'listed', exitCode: 0, stdout: 'text', stderr: '' }), 'PROTOCOL_ERROR'],
    ];
    for (const [act, code] of cases) {
      const worker = fakeWorker();
      const job = runDecoderJob(worker, { context, limits });
      act(worker);
      await expectCode(job, code);
    }
  });
});

describe('hostile and damaged archives', () => {
  it('rejects unsafe and duplicate member paths', async () => {
    await expectCode(listArchiveEntries(fixture('unsafe-path.7z'), { format: '7z' }), 'ARCHIVE_ENTRY_UNSAFE');
    await expectCode(listArchiveEntries(fixture('duplicate-names.7z'), { format: '7z' }), 'ARCHIVE_ENTRY_AMBIGUOUS');
  });

  it('does not trust exit code 0 when the displayed name selects nothing', async () => {
    const listing = await listArchiveEntries(fixture('control-char-name.7z'), { format: '7z' });
    expect(listing.entries[0].path).toBe('bad_name.txt');
    await expectCode(extractArchiveMember(fixture('control-char-name.7z'), 'bad_name.txt', { format: '7z' }), 'EXTRACTION_FAILED');
  });

  it('refuses a zero-byte member whose displayed name selects nothing', async () => {
    // The review case: one empty member stored as "bad\nname.txt", listed as "bad_name.txt".
    const archive = path.join(tempDir, 'control-char-empty.7z');
    fs.writeFileSync(archive, await make7z([['bad\nname.txt', new Uint8Array(0)]]));
    expect(fs.statSync(archive).size).toBe(86);
    const listing = await listArchiveEntries(archive, { format: '7z' });
    expect(listing.entries).toEqual([expect.objectContaining({ path: 'bad_name.txt', type: 'file', size: 0, crc32: null })]);

    const error = await expectCode(extractArchiveMember(archive, 'bad_name.txt', { format: '7z' }), 'EXTRACTION_FAILED');
    expect(error.message).toMatch(/selected unambiguously/);
    expectAllReleased();
  }, 30000);

  it('extracts genuinely empty members and ordinary members once their identity is verified', async () => {
    const archive = path.join(tempDir, 'empty-member.7z');
    fs.writeFileSync(archive, await make7z([['empty.txt', new Uint8Array(0)], ['page.bin', Buffer.from('hello')]]));
    const empty = await extractArchiveMember(archive, 'empty.txt', { format: '7z' });
    expect(empty.entry).toMatchObject({ path: 'empty.txt', size: 0 });
    expect(empty.data.length).toBe(0);
    const page = await extractArchiveMember(archive, 'page.bin', { format: '7z' });
    expect(page.data.toString()).toBe('hello');
    await expectCode(extractArchiveMember(archive, 'missing.txt', { format: '7z' }), 'MEMBER_NOT_FOUND');
    expectAllReleased();
  }, 30000);

  describe('deeply nested member paths (review: 600 entries, ~509 segments each)', () => {
    let deepArchive;
    beforeAll(async () => {
      const files = Array.from({ length: DEEP_ENTRY_COUNT }, (_, index) => ['f' + index, new Uint8Array(0)]);
      deepArchive = path.join(tempDir, 'deep-paths.7z');
      fs.writeFileSync(deepArchive, await make7z(files, files.map(([name], index) => [name, deepPath(index)])));
    }, 60000);

    it('lists and extracts them under the default limits', async () => {
      // Same shape as the reviewed archive (1,195,199 bytes there): uncompressed UTF-16 names.
      expect(fs.statSync(deepArchive).size).toBeGreaterThan(MIB);
      const listing = await listArchiveEntries(deepArchive, { format: '7z' });
      expect(listing.entries).toHaveLength(DEEP_ENTRY_COUNT);
      // 7-Zip stores added files in its own name order, so compare the set of paths.
      expect(listing.entries.map((entry) => entry.path).sort())
        .toEqual(Array.from({ length: DEEP_ENTRY_COUNT }, (_, index) => deepPath(index)).sort());
      expect(listing.entries[0].path.split('/').length).toBeGreaterThan(500);

      const last = await extractArchiveMember(deepArchive, deepPath(DEEP_ENTRY_COUNT - 1), { format: '7z' });
      expect(last.entry.size).toBe(0);
      expectAllReleased();
    }, 30000);

    it('validates them inside a 64 MiB parent heap (the unfixed code exhausted 128 MiB)', () => {
      // A separate process, as in the review, so the heap cap applies to parent-side validation.
      // Measurements are reported, not asserted: they depend on the machine.
      const script = `
        const { listArchiveEntries } = await import(${JSON.stringify(new URL('../src/services/archive-member-decoder.js', import.meta.url).href)});
        globalThis.gc();
        const before = process.memoryUsage();
        let peakHeap = before.heapUsed;
        let peakRss = before.rss;
        const sample = setInterval(() => {
          const now = process.memoryUsage();
          peakHeap = Math.max(peakHeap, now.heapUsed);
          peakRss = Math.max(peakRss, now.rss);
        }, 1);
        const started = performance.now();
        const listing = await listArchiveEntries(process.argv[1], { format: '7z' });
        const elapsedMs = Math.round(performance.now() - started);
        clearInterval(sample);
        const after = process.memoryUsage();
        const mib = (bytes) => Math.round(bytes / 10485.76) / 100;
        console.log(JSON.stringify({
          entries: listing.entries.length,
          elapsedMs,
          heapGrowthMiB: mib(Math.max(peakHeap, after.heapUsed) - before.heapUsed),
          rssGrowthMiB: mib(Math.max(peakRss, after.rss) - before.rss),
        }));
      `;
      const child = spawnSync(process.execPath, [
        '--max-old-space-size=64', '--expose-gc', '--input-type=module', '-e', script, deepArchive,
      ], { encoding: 'utf8', timeout: 60000 });
      expect(child.status, child.stderr).toBe(0);
      const measured = JSON.parse(child.stdout.trim().split('\n').at(-1));
      console.info('deep listing in a 64 MiB heap:', measured);
      expect(measured.entries).toBe(DEEP_ENTRY_COUNT);
    }, 60000);
  });

  it('rejects corrupt, truncated, padded and mislabelled input', async () => {
    await expectCode(extractArchiveMember(fixture('rar5-bad-tables.rar'), 'bad_tables.txt', { format: 'rar' }), 'ARCHIVE_CORRUPT');

    const write = (name, bytes) => {
      const target = path.join(tempDir, name);
      fs.writeFileSync(target, bytes);
      return target;
    };
    const solid7z = fs.readFileSync(fixture('pages-solid.7z'));
    const solidRar = fs.readFileSync(fixture('rar5-solid.rar'));
    await expectCode(listArchiveEntries(write('cut.7z', solid7z.subarray(0, solid7z.length - 200)), { format: '7z' }), 'ARCHIVE_CORRUPT');
    const cutRar = write('cut.rar', solidRar.subarray(0, 400));
    await expect(extractArchiveMember(cutRar, 'test4.bin', { format: 'rar' })).rejects.toBeInstanceOf(ArchiveDecoderError);
    await expectCode(listArchiveEntries(write('padded.rar', Buffer.concat([solidRar, Buffer.alloc(64)])), { format: 'rar' }), 'ARCHIVE_CORRUPT');

    const flipped = Buffer.from(solid7z);
    flipped[100] ^= 0xff;
    await expect(extractArchiveMember(write('flipped.7z', flipped), 'book/page-01.bin', { format: '7z' }))
      .rejects.toBeInstanceOf(ArchiveDecoderError);

    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: '7z' }), 'UNSUPPORTED_FORMAT');
    await expectCode(listArchiveEntries(write('note.rar', 'not an archive'), { format: 'rar' }), 'UNSUPPORTED_FORMAT');
    await expectCode(listArchiveEntries(tempDir, { format: 'rar' }), 'INPUT_UNAVAILABLE');
    await expectCode(listArchiveEntries(fixture('rar5-solid.rar'), { format: 'zip' }), 'INVALID_ARGUMENT');
    expectAllReleased();
  });
});

describe('listing validation', () => {
  const context = { expectedType: 'Rar5', inputSize: 50, maxEntries: 10, maxPathLength: 64 };
  const header = ['', 'Listing archive: /in/archive', '', '--', 'Path = /in/archive', 'Type = Rar5', 'Physical Size = 50'];
  const record = (name, extra = []) => [`Path = ${name}`, 'Folder = -', 'Size = 1', 'Attributes = A', ...extra, ''];
  const listing = (records, headerExtra = []) => [...header, ...headerExtra, '', '----------', ...records.flat(), ''].join('\n');
  const interpret = (text) => () => interpretListing({ exitCode: 0, stdout: text, stderr: '' }, context);
  const codeOf = (fn) => {
    try {
      fn();
      return null;
    } catch (error) {
      return error.code;
    }
  };

  it.each([
    ['/abs.jpg', 'ARCHIVE_ENTRY_UNSAFE'],
    ['C:/x.jpg', 'ARCHIVE_ENTRY_UNSAFE'],
    ['a\\b.jpg', 'ARCHIVE_ENTRY_UNSAFE'],
    ['a/../b.jpg', 'ARCHIVE_ENTRY_UNSAFE'],
    ['./b.jpg', 'ARCHIVE_ENTRY_UNSAFE'],
    ['a//b.jpg', 'ARCHIVE_ENTRY_UNSAFE'],
    ['x'.repeat(65), 'ARCHIVE_ENTRY_UNSAFE'],
  ])('rejects member path %s', (name, code) => {
    expect(codeOf(interpret(listing([record(name)])))).toBe(code);
  });

  it('rejects case-folded duplicates and file/directory collisions', () => {
    expect(codeOf(interpret(listing([record('P1.jpg'), record('p1.jpg')])))).toBe('ARCHIVE_ENTRY_AMBIGUOUS');
    expect(codeOf(interpret(listing([record('a'), record('a/b.jpg')])))).toBe('ARCHIVE_ENTRY_AMBIGUOUS');
    expect(codeOf(interpret(listing([record('\u00e9.jpg'), record('e\u0301.jpg')])))).toBe('ARCHIVE_ENTRY_AMBIGUOUS');
  });

  it('finds a file used as an ancestor at any depth and in any order, without false positives', () => {
    const folder = (name) => [`Path = ${name}`, 'Folder = +', 'Attributes = D', ''];
    const reject = [
      [record('a/b'), record('a/b/c.jpg')],
      [record('a/b/c/d.jpg'), record('a/b')],
      // "a/b-c" sorts between "a/b" and "a/b/", so the descendant is not adjacent to the file.
      [record('a/b'), record('a/b-c/x.jpg'), record('a/b.d'), record('a/b/y.jpg')],
      [record('x/y/z'), record('x/y/z/w/v/u.jpg')],
      [record('a'), folder('a')],
      [record('a.jpg'), record('a.jpg')],
    ];
    for (const records of reject) expect(codeOf(interpret(listing(records)))).toBe('ARCHIVE_ENTRY_AMBIGUOUS');

    const accept = [
      [record('a/b'), record('a/b-c/x.jpg'), record('a/b.d'), record('a/bc/y.jpg')],
      [folder('a'), record('a/b.jpg'), folder('a'), folder('a/c'), record('a/c/d.jpg')],
      [record('a/b.jpg'), record('b/a.jpg'), record('ab')],
    ];
    for (const records of accept) expect(codeOf(interpret(listing(records)))).toBeNull();
  });

  it('accepts valid nested paths up to the path length limit', () => {
    const deep = { ...context, maxEntries: DEEP_ENTRY_COUNT, maxPathLength: 1024 };
    const records = Array.from({ length: DEEP_ENTRY_COUNT }, (_, index) => record(deepPath(index)));
    const result = interpretListing({ exitCode: 0, stdout: listing(records), stderr: '' }, deep);
    expect(result.entries).toHaveLength(DEEP_ENTRY_COUNT);
    expect(result.entries.at(-1).path).toBe(deepPath(DEEP_ENTRY_COUNT - 1));
    const tooLong = [record('a/'.repeat(512) + 'b')];
    expect(codeOf(() => interpretListing({ exitCode: 0, stdout: listing(tooLong), stderr: '' }, deep))).toBe('ARCHIVE_ENTRY_UNSAFE');
  });

  it('consults the checkpoint per record while parsing and per entry while checking collisions', () => {
    const records = [record('a.jpg'), record('b.jpg'), record('../late-unsafe.jpg')];
    let calls = 0;
    const counting = () => {
      calls += 1;
    };
    expect(codeOf(() => interpretListing({ exitCode: 0, stdout: listing(records.slice(0, 2)), stderr: '' }, { ...context, checkpoint: counting }))).toBeNull();
    expect(calls).toBe(2 + 2 + 2);
    // A checkpoint that stops the job wins before later records are even parsed.
    const stop = () => {
      throw Object.assign(new Error('deadline'), { code: 'TIMEOUT' });
    };
    expect(codeOf(() => interpretListing({ exitCode: 0, stdout: listing(records), stderr: '' }, { ...context, checkpoint: stop }))).toBe('TIMEOUT');
  });

  it('classifies special entries as unsupported', () => {
    const special = interpretListing({
      exitCode: 0,
      stdout: listing([
        record('fifo', ['Characteristics = UnixTime']).map((line) => line === 'Attributes = A' ? 'Attributes =  prw-r--r--' : line),
        record('stream', ['Alternate Stream = +']),
        record('ok.jpg'),
      ]),
      stderr: '',
    }, context);
    expect(special.entries.map((entry) => entry.type)).toEqual(['unsupported', 'unsupported', 'file']);
  });

  it('refuses multi-line entry values and injected records', () => {
    const injected = [...record('link', ['Symbolic Link = ', '{', 'x', '}']).slice(0, -1), '', ...record('evil.jpg')];
    expect(codeOf(interpret(listing([injected])))).toBe('ARCHIVE_CORRUPT');
  });

  it('accepts a multi-line archive comment but not one that forges the separator', () => {
    const ok = interpret(listing([record('a.jpg')], ['Comment = ', '{', 'line one', '', 'Path = fake', '}']))();
    expect(ok.entries.map((entry) => entry.path)).toEqual(['a.jpg']);
    const forged = listing([record('a.jpg')], ['Comment = ', '{', 'x', '}', '', '----------', ...record('evil.jpg'), 'Comment = ', '{', '}']);
    expect(codeOf(interpret(forged))).toBe('ARCHIVE_CORRUPT');
  });

  it('fails on decoder error footers and duplicate header keys', () => {
    expect(codeOf(interpret(listing([record('a.jpg')]) + '\nErrors: 1\n'))).toBe('ARCHIVE_CORRUPT');
    expect(codeOf(interpret(listing([record('a.jpg')], ['Type = Rar5'])))).toBe('ARCHIVE_CORRUPT');
    expect(codeOf(interpret(listing([record('a.jpg')], ['Offset = 7'])))).toBe('UNSUPPORTED_FORMAT');
  });
});
