import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as RealWorker } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

const tracked = vi.hoisted(() => ({ workers: [], hooks: { inspect: null, readOnlyPack: false } }));

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

// Lets a test act while pages are being verified (the decoder may still be running).
vi.mock('../src/services/cbz-page-reader.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async inspectImage(...args) {
      const hook = tracked.hooks.inspect;
      if (hook) await hook();
      return actual.inspectImage(...args);
    },
  };
});

// Simulates a staging file the decoder cannot write to (as on a failing disk).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const open = (file, flags, mode) => {
    if (tracked.hooks.readOnlyPack && String(file).endsWith('pages.bin') && typeof flags === 'number'
      && (flags & fs.constants.O_EXCL)) {
      return actual.open(file, (flags & ~fs.constants.O_RDWR) | fs.constants.O_RDONLY, mode);
    }
    return actual.open(file, flags, mode);
  };
  return { ...actual, open, default: { ...actual, open } };
});

const { prepareSolidCbrCb7 } = await import('../src/services/cbr-cb7-preparation.js');
const { readCbrCb7Page } = await import('../src/services/cbr-cb7-page-reader.js');
const { BATCH_ARGV_BYTES, extractOpenedArchiveBatch, runDecoderJob } = await import('../src/services/archive-member-decoder.js');

const SevenZip = createRequire(import.meta.url)('7z-wasm');
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const DECODER_FIXTURES = fileURLToPath(new URL('./fixtures/archive-decoder/', import.meta.url));
const VENDOR = fileURLToPath(new URL('../vendor/7zip-wasm/', import.meta.url));
const WORKER_URL = new URL('../src/services/archive-member-decoder-worker.js', import.meta.url);
const MIB = 1024 * 1024;
const PAGE_PATHS = ['ch1/page1.jpg', 'ch1/page2.png', 'ch1/page10.webp', 'ch2/page1.gif', 'ch2/page2.png', 'ch10/page1.png'];

let tempDir;
let stagingRoot;
const files = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cbr-cb7-prep-'));
  const gradient = (width, height, seed) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) & 0xff;
    return sharp(raw, { raw: { width, height, channels: 3 } });
  };
  files.jpeg = await gradient(48, 64, 10).jpeg().toBuffer();
  files.png = await gradient(48, 64, 20).png({ compressionLevel: 0 }).toBuffer();
  files.webp = await gradient(48, 64, 30).webp({ lossless: true }).toBuffer();
  files.bigPng = await gradient(96, 128, 40).png({ compressionLevel: 0 }).toBuffer();
  files.gif = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#ff0000' } }).gif().toBuffer();
  // Noise does not compress, so stream offsets track page order and a flipped byte lands mid-comic.
  files.noise = async (seed) => {
    const raw = Buffer.alloc(64 * 64 * 3);
    let state = seed;
    for (let i = 0; i < raw.length; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      raw[i] = state >>> 24;
    }
    return sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  };
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
});

beforeEach(() => {
  tracked.workers.length = 0;
  tracked.hooks.inspect = null;
  tracked.hooks.readOnlyPack = false;
  stagingRoot = fs.mkdtempSync(path.join(tempDir, 'staging-'));
});

function comicEntries() {
  return [
    ['ch1/page10.webp', files.webp],
    ['ch2/page1.gif', files.gif],
    ['ch1/page1.jpg', files.jpeg],
    ['ch2/page2.png', Buffer.from('this is not a png image, only text bytes. '.repeat(20))],
    ['ch1/page2.png', files.png],
    ['__MACOSX/ch1/._page1.jpg', Buffer.from('AppleDouble')],
    ['ComicInfo.xml', Buffer.from('<ComicInfo/>')],
    ['ch10/page1.png', files.bigPng],
  ];
}

async function make7z(entries, switches = ['-ms=on']) {
  const module = await SevenZip({ print() {}, printErr() {} });
  module.FS.mkdirTree('/w');
  module.FS.chdir('/w');
  for (const [name, data] of entries) {
    const dir = path.posix.dirname(name);
    if (dir !== '.') module.FS.mkdirTree('/w/' + dir);
    module.FS.writeFile('/w/' + name, data);
  }
  const code = module.callMain([
    'a', '-t7z', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-bsp0', '-bso0', '-bse0', ...switches, '/out.7z', ...entries.map(([name]) => name),
  ]);
  if (code !== 0) throw new Error('7z-wasm failed with ' + code);
  return Buffer.from(module.FS.readFile('/out.7z'));
}

// 7-Zip always stores member CRCs in 7z. This rewrites a plain (-mhc=off) header's per-file
// digest record (kCRC, all defined, CRCs) as "none defined", giving a valid CRC-less solid 7z.
function withoutMemberCrcs(archive, contents) {
  const headerStart = 32 + Number(archive.readBigUInt64LE(12));
  const header = archive.subarray(headerStart, headerStart + Number(archive.readBigUInt64LE(20)));
  const digests = Buffer.concat([Buffer.from([0x0a, 0x01]), ...contents.map((data) => {
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(data));
    return crc;
  })]);
  const at = header.indexOf(digests);
  if (header[0] !== 0x01 || at < 0 || header.indexOf(digests, at + 1) >= 0) throw new Error('unexpected 7z header');
  const none = Buffer.concat([Buffer.from([0x0a, 0x00]), Buffer.alloc(Math.ceil(contents.length / 8))]);
  const rewritten = Buffer.concat([header.subarray(0, at), none, header.subarray(at + digests.length)]);
  const out = Buffer.concat([archive.subarray(0, headerStart), rewritten]);
  out.writeBigUInt64LE(BigInt(rewritten.length), 20);
  out.writeUInt32LE(crc32(rewritten), 28);
  out.writeUInt32LE(crc32(out.subarray(12, 32)), 8);
  return out;
}

// Changes the first byte and four bytes after it so the CRC32 of `bytes` stays the same
// (CRC32 is linear over XOR differences of equal-length data).
function crcPreservingChange(bytes) {
  const base = crc32(bytes);
  const effect = (patch) => {
    const changed = Buffer.from(bytes);
    for (const [index, value] of patch) changed[index] ^= value;
    return (crc32(changed) ^ base) >>> 0;
  };
  const first = [[0, bytes[0]]];
  const rows = [];
  for (let bit = 0; bit < 32; bit += 1) rows.push({ effect: effect([[1 + (bit >> 3), 1 << (bit & 7)]]), bits: 2 ** bit });
  // Gaussian elimination over GF(2): find the bits whose effects cancel the first change.
  let target = effect(first);
  let chosen = 0;
  for (let pivot = 31; pivot >= 0; pivot -= 1) {
    const mask = 2 ** pivot;
    const row = rows.find((candidate) => (candidate.effect & mask) >>> 0);
    if (!row) continue;
    rows.splice(rows.indexOf(row), 1);
    for (const other of rows) {
      if ((other.effect & mask) >>> 0) {
        other.effect = (other.effect ^ row.effect) >>> 0;
        other.bits ^= row.bits;
      }
    }
    if ((target & mask) >>> 0) {
      target = (target ^ row.effect) >>> 0;
      chosen ^= row.bits;
    }
  }
  if (target !== 0) throw new Error('no CRC-preserving change found');
  const changed = Buffer.from(bytes);
  changed[0] = 0;
  for (let bit = 0; bit < 32; bit += 1) if (chosen & 2 ** bit) changed[1 + (bit >> 3)] ^= 1 << (bit & 7);
  if (crc32(changed) !== base || changed.equals(bytes)) throw new Error('CRC-preserving change failed');
  return changed;
}

function overwriteStaged(prepared, offset, bytes) {
  fs.chmodSync(prepared.filePath, 0o600);
  const before = fs.statSync(prepared.filePath);
  const fd = fs.openSync(prepared.filePath, 'r+');
  fs.writeSync(fd, bytes, 0, bytes.length, offset);
  fs.closeSync(fd);
  const after = fs.statSync(prepared.filePath);
  expect([after.size, after.ino]).toEqual([before.size, before.ino]);
}

let counter = 0;
function writeTemp(bytes, extension) {
  counter += 1;
  const target = path.join(tempDir, 'comic-' + counter + extension);
  fs.writeFileSync(target, bytes);
  return target;
}

async function withOpen(file, callback) {
  const handle = await fs.promises.open(file, 'r');
  try {
    return await callback({ handle, stat: await handle.stat() });
  } finally {
    await handle.close();
  }
}

async function expectCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ name: 'ArchiveDecoderError', code });
}

const stagingContents = () => fs.readdirSync(stagingRoot);

async function allWorkersStopped() {
  for (const worker of tracked.workers) {
    if (worker.threadId !== -1) await new Promise((resolve) => worker.once('exit', resolve));
  }
}

describe('solid comic preparation', () => {
  it('prepares solid RAR4, RAR5 and 7z comics exactly like per-page reads', async () => {
    const comics = [
      [path.join(COMICS, 'comic-rar4-solid.cbr'), 'cbr', 'rar4'],
      [path.join(COMICS, 'comic-rar5-solid.cbr'), 'cbr', 'rar5'],
      [writeTemp(await make7z(comicEntries()), '.cb7'), 'cb7', '7z'],
    ];
    for (const [file, format, container] of comics) {
      await withOpen(file, async (openFile) => {
        const prepared = await prepareSolidCbrCb7(openFile, { format, stagingRoot });
        try {
          expect(prepared).toMatchObject({ format, container, solid: true, pageCount: 6, complete: false });
          expect(prepared.pages.map((page) => page.member.path)).toEqual(PAGE_PATHS);
          expect(prepared.slots.map((slot) => slot.position)).toEqual([1, 2, 3, 4, 5, 6]);
          expect(prepared.slots.map((slot) => slot.code ?? slot.status))
            .toEqual(['ready', 'ready', 'ready', 'ready', 'PAGE_INVALID_IMAGE', 'ready']);

          // One generated directory holding one fixed-name file; no archive name reaches the host.
          const [directory] = stagingContents();
          expect(stagingContents()).toHaveLength(1);
          expect(directory).toMatch(/^comic-prep-/);
          expect(fs.readdirSync(path.join(stagingRoot, directory))).toEqual(['pages.bin']);
          expect(prepared.filePath).toBe(path.join(stagingRoot, directory, 'pages.bin'));
          expect(fs.statSync(prepared.filePath).size).toBe(prepared.preparedBytes);

          let end = 0;
          for (const slot of prepared.slots.filter((candidate) => candidate.status === 'ready')) {
            const fromPreparation = await prepared.read(slot.position);
            const direct = await readCbrCb7Page(openFile, slot.position, { format });
            expect(fromPreparation.page).toEqual(direct.page);
            expect(fromPreparation.bytes.equals(direct.bytes)).toBe(true);
            expect(fromPreparation.image).toEqual(direct.image);
            expect(slot.length).toBe(direct.page.uncompressedSize);
            expect(crc32(fromPreparation.bytes)).toBe(direct.page.crc32);
            end = Math.max(end, slot.offset + slot.length);
          }
          expect(end).toBeLessThanOrEqual(prepared.preparedBytes);
          await expectCode(prepared.read(5), 'PAGE_INVALID_IMAGE');
          await expectCode(prepared.read(7), 'PAGE_NOT_FOUND');
        } finally {
          await prepared.dispose();
        }
        expect(prepared.disposed).toBe(true);
        expect(stagingContents()).toEqual([]);
        await expectCode(prepared.read(1), 'PREPARATION_DISPOSED');
        await prepared.dispose();
      });
    }
  });

  it('refuses non-solid archives without leaving staging data', async () => {
    await withOpen(path.join(COMICS, 'comic-rar5.cbr'), (openFile) =>
      expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot }), 'ARCHIVE_NOT_SOLID'));
    const nonSolid7z = writeTemp(await make7z(comicEntries(), ['-ms=off']), '.cb7');
    await withOpen(nonSolid7z, (openFile) =>
      expectCode(prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot }), 'ARCHIVE_NOT_SOLID'));
    expect(stagingContents()).toEqual([]);
  });

  it('enforces the disk and page budgets before extracting anything', async () => {
    const file = path.join(COMICS, 'comic-rar5-solid.cbr');
    await withOpen(file, async (openFile) => {
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot, limits: { maxPreparedBytes: 1000 } }),
        'PREPARATION_LIMIT_EXCEEDED');
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot, limits: { maxPreparedPages: 2 } }),
        'PREPARATION_LIMIT_EXCEEDED');
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot, limits: { maxPreparedBytes: 0 } }),
        'INVALID_ARGUMENT');
    });
    expect(stagingContents()).toEqual([]);
  });

  it('splits selections longer than the argument budget into several runs', async () => {
    const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    const folder = 'a-chapter-folder-with-a-deliberately-long-descriptive-name';
    const entries = Array.from({ length: 320 }, (_, index) => [folder + '/page-' + (index + 1) + '.png', tiny]);
    const argv = entries.reduce((sum, [name]) => sum + Buffer.byteLength(name) + 5, 0);
    expect(argv).toBeGreaterThan(BATCH_ARGV_BYTES);
    await withOpen(writeTemp(await make7z(entries), '.cb7'), async (openFile) => {
      const prepared = await prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot });
      try {
        expect(prepared.complete).toBe(true);
        expect(prepared.pageCount).toBe(320);
        // Natural order: page-2 before page-10.
        expect(prepared.pages.slice(0, 3).map((page) => page.name)).toEqual(['page-1.png', 'page-2.png', 'page-3.png']);
        expect(prepared.preparedBytes).toBe(320 * tiny.length);
        expect((await prepared.read(320)).bytes.equals(tiny)).toBe(true);
      } finally {
        await prepared.dispose();
      }
    });
  });

  it('keeps CRC-verified pages and numbers the corrupt ones when a solid stream breaks', async () => {
    const entries = [];
    for (let index = 1; index <= 6; index += 1) entries.push(['page' + index + '.png', await files.noise(index)]);
    const archive = await make7z(entries, ['-ms=on', '-mx=1']);
    archive[Math.floor(archive.length * 0.6)] ^= 0x55;
    await withOpen(writeTemp(archive, '.cb7'), async (openFile) => {
      const prepared = await prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot });
      try {
        const statuses = prepared.slots.map((slot) => slot.code ?? slot.status);
        expect(prepared.complete).toBe(false);
        expect(statuses[0]).toBe('ready');
        expect(statuses.at(-1)).toBe('PAGE_CORRUPT');
        // Positions stay stable: everything after the first corrupt page is an error slot.
        const firstCorrupt = statuses.indexOf('PAGE_CORRUPT');
        expect(statuses.slice(firstCorrupt).every((status) => status === 'PAGE_CORRUPT')).toBe(true);
        for (let position = 1; position <= firstCorrupt; position += 1) {
          expect((await prepared.read(position)).bytes.equals(entries[position - 1][1])).toBe(true);
        }
        await expectCode(prepared.read(firstCorrupt + 1), 'PAGE_CORRUPT');
        await expectCode(readCbrCb7Page(openFile, firstCorrupt + 1, { format: 'cb7' }), 'PAGE_CORRUPT');
      } finally {
        await prepared.dispose();
      }
    });
  });

  it('detects prepared output changed after preparation', async () => {
    await withOpen(path.join(COMICS, 'comic-rar5-solid.cbr'), async (openFile) => {
      const prepared = await prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot });
      try {
        const slot = prepared.slots[0];
        fs.chmodSync(prepared.filePath, 0o600);
        const fd = fs.openSync(prepared.filePath, 'r+');
        fs.writeSync(fd, Buffer.from([0]), 0, 1, slot.offset + 10);
        fs.closeSync(fd);
        await expectCode(prepared.read(1), 'PREPARATION_CHANGED');
      } finally {
        await prepared.dispose();
      }
      expect(stagingContents()).toEqual([]);
    });
  });

  it('checks every ready page against its recorded digest, with or without an archive CRC', async () => {
    const pages = [];
    for (let index = 1; index <= 3; index += 1) pages.push(['page' + index + '.png', await files.noise(10 + index)]);
    const plain = await make7z(pages, ['-ms=on', '-mhc=off']);
    const archives = [[withoutMemberCrcs(plain, pages.map(([, data]) => data)), null], [plain, 'crc32']];
    for (const [archive, crcKind] of archives) {
      await withOpen(writeTemp(archive, '.cb7'), async (openFile) => {
        const prepared = await prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot });
        try {
          expect(prepared.complete).toBe(true);
          expect(prepared.pages.map((page) => (page.crc32 === null ? null : 'crc32'))).toEqual([crcKind, crcKind, crcKind]);
          // Unchanged pages read back exactly, at their own offsets.
          for (const [index, [, data]] of pages.entries()) expect((await prepared.read(index + 1)).bytes.equals(data)).toBe(true);
          // No digest data is exposed in the public slots.
          expect(Object.keys(prepared.slots[0]).sort()).toEqual(['image', 'length', 'offset', 'position', 'status']);

          // Same length and inode: the PNG signature's first byte 137 -> 0 (and, where a CRC32
          // exists, four more bytes chosen so the CRC32 still matches).
          const original = pages[1][1];
          const changed = crcKind ? crcPreservingChange(original) : Buffer.concat([Buffer.from([0]), original.subarray(1)]);
          expect(original[0]).toBe(137);
          expect(crcKind === null || crc32(changed) === crc32(original)).toBe(true);
          overwriteStaged(prepared, prepared.slots[1].offset, changed);
          await expectCode(prepared.read(2), 'PREPARATION_CHANGED');
          // Neighbouring pages are untouched and still served.
          expect((await prepared.read(1)).bytes.equals(pages[0][1])).toBe(true);
          expect((await prepared.read(3)).bytes.equals(pages[2][1])).toBe(true);

          // Restoring the verified bytes makes the page readable again; nothing was re-cached.
          overwriteStaged(prepared, prepared.slots[1].offset, original);
          const restored = await prepared.read(2);
          expect(restored.bytes.equals(original)).toBe(true);
          expect(restored.image).toEqual(prepared.slots[1].image);
        } finally {
          await prepared.dispose();
        }
        expect(stagingContents()).toEqual([]);
        await expectCode(prepared.read(2), 'PREPARATION_DISPOSED');
      });
    }
  });

  it('prepares thousands of short page names over several near-budget runs', async () => {
    // Each run's argument vector is close to the 16 KiB budget, and the runs together are far
    // over 7-Zip's 64 KiB stack: this fails if argument stack space is not returned per command.
    const count = 2000;
    const entries = [];
    for (let index = 1; index <= count; index += 1) {
      const background = { r: index & 0xff, g: (index >> 8) & 0xff, b: 77 };
      entries.push(['p' + String(index).padStart(4, '0') + '.png',
        await sharp({ create: { width: 1, height: 1, channels: 3, background } }).png().toBuffer()]);
    }
    const perRun = Math.floor((BATCH_ARGV_BYTES - 1024) / 20); // 16-byte aligned name + pointer
    expect(Math.ceil(count / perRun)).toBeGreaterThanOrEqual(3);
    await withOpen(writeTemp(await make7z(entries), '.cb7'), async (openFile) => {
      const prepared = await prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot });
      try {
        expect(prepared.complete).toBe(true);
        expect(prepared.pageCount).toBe(count);
        for (let position = 1; position <= count; position += 1) {
          const { page, bytes } = await prepared.read(position);
          expect(page.member.path).toBe(entries[position - 1][0]);
          if (!bytes.equals(entries[position - 1][1])) throw new Error('page ' + position + ' differs');
        }
      } finally {
        await prepared.dispose();
      }
    });
  }, 30_000);
});

describe('preparation failures discard everything', () => {
  const solid7z = async () => writeTemp(await make7z(comicEntries()), '.cb7');

  it('cancels during preparation, stops the worker and removes staging', async () => {
    const controller = new AbortController();
    tracked.hooks.inspect = async () => controller.abort();
    await withOpen(await solid7z(), (openFile) =>
      expectCode(prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot, signal: controller.signal }), 'CANCELLED'));
    expect(stagingContents()).toEqual([]);
    await allWorkersStopped();
    expect(tracked.workers.length).toBeGreaterThan(0);
  });

  it('times out when verification outlasts the deadline and removes staging', async () => {
    tracked.hooks.inspect = () => new Promise((resolve) => setTimeout(resolve, 1600));
    await withOpen(await solid7z(), (openFile) =>
      expectCode(prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot, limits: { timeoutMs: 1500 } }), 'TIMEOUT'));
    expect(stagingContents()).toEqual([]);
    await allWorkersStopped();
  });

  it('refuses to publish when the source changes during preparation', async () => {
    const file = await solid7z();
    let changed = false;
    tracked.hooks.inspect = async () => {
      if (changed) return;
      changed = true;
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
    };
    await withOpen(file, (openFile) => expectCode(prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot }), 'INPUT_CHANGED'));
    expect(stagingContents()).toEqual([]);
  });

  it('refuses a source that changed before preparation started', async () => {
    const file = await solid7z();
    await withOpen(file, async (openFile) => {
      fs.appendFileSync(file, Buffer.from([0]));
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot }), 'INPUT_CHANGED');
    });
    expect(stagingContents()).toEqual([]);
  });

  it('removes staging when the decoder cannot write prepared output', async () => {
    tracked.hooks.readOnlyPack = true;
    await withOpen(await solid7z(), (openFile) =>
      expectCode(prepareSolidCbrCb7(openFile, { format: 'cb7', stagingRoot }), 'OUTPUT_WRITE_FAILED'));
    expect(stagingContents()).toEqual([]);
    await allWorkersStopped();
  });

  it('names its staging directory to the owner and keeps it when the owner refuses removal', async () => {
    tracked.hooks.readOnlyPack = true;
    const claimed = [];
    const asked = [];
    const refusal = new Error('refused');
    const caught = await withOpen(await solid7z(), (openFile) => prepareSolidCbrCb7(openFile, {
      format: 'cb7',
      stagingRoot,
      onStaging: (directory) => claimed.push(directory),
      beforeStagingRemoval: async (directory) => {
        asked.push(directory);
        throw refusal;
      },
    }).then(() => null, (err) => err));
    expect(caught).toMatchObject({ name: 'ArchiveDecoderError', code: 'OUTPUT_WRITE_FAILED', cleanupError: refusal });
    expect(claimed).toHaveLength(1);
    expect(path.dirname(claimed[0])).toBe(stagingRoot);
    expect(asked).toEqual(claimed);
    // The refused directory is left exactly where it was, for its owner.
    expect(stagingContents()).toEqual([path.basename(claimed[0])]);
    await allWorkersStopped();

    // An owner that refuses the directory itself: nothing is decoded and it is removed again.
    tracked.hooks.readOnlyPack = false;
    const workers = tracked.workers.length;
    await withOpen(path.join(COMICS, 'comic-rar5-solid.cbr'), (openFile) => expectCode(prepareSolidCbrCb7(openFile, {
      format: 'cbr',
      stagingRoot,
      onStaging: () => { throw new Error('not mine'); },
    }), 'STAGING_UNAVAILABLE'));
    expect(stagingContents()).toEqual([path.basename(claimed[0])]);
    expect(tracked.workers.length).toBe(workers);
    await expectCode(withOpen(path.join(COMICS, 'comic-rar5-solid.cbr'), (openFile) =>
      prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot, onStaging: 'yes' })), 'INVALID_ARGUMENT');
  });

  it('accepts only an absolute, existing staging directory', async () => {
    await withOpen(path.join(COMICS, 'comic-rar5-solid.cbr'), async (openFile) => {
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot: 'relative/staging' }), 'INVALID_ARGUMENT');
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot: path.join(stagingRoot, 'missing') }), 'STAGING_UNAVAILABLE');
      const notDirectory = path.join(stagingRoot, 'file');
      fs.writeFileSync(notDirectory, 'x');
      await expectCode(prepareSolidCbrCb7(openFile, { format: 'cbr', stagingRoot: notDirectory }), 'STAGING_UNAVAILABLE');
    });
    expect(tracked.workers).toEqual([]);
  });
});

describe('A1 batch extraction', () => {
  const LISTING = (members) => [
    '', '7-Zip (z) 26.06', '', 'Listing archive: /in/archive', '', '--',
    'Path = /in/archive', 'Type = 7z', 'Physical Size = 100', 'Solid = +', '', '----------',
    ...members.flatMap(([name, size, crc]) => ['Path = ' + name, 'Size = ' + size, 'Packed Size = ', 'Attributes = A', 'CRC = ' + crc, '']),
    '',
  ].join('\n');
  const BOTH = [['a.bin', 3, '352441C2'], ['b.bin', 2, '9E83486D']];
  const context = { expectedType: '7z', inputSize: 100, maxEntries: 10, maxPathLength: 1024 };
  const limits = { timeoutMs: 1000, maxMemberBytes: 1024 };
  const listed = (members = BOTH) => ({ exitCode: 0, stdout: new TextEncoder().encode(LISTING(members)), stderr: '' });

  function start(select = () => ['b.bin', 'a.bin']) {
    const worker = new EventEmitter();
    worker.postMessage = vi.fn();
    const onMember = vi.fn();
    const job = runDecoderJob(worker, { context, limits, batch: { select, onMember, maxMembers: 10, maxBytes: 100 } });
    worker.emit('message', { type: 'listed', ...listed() });
    return { worker, job, onMember };
  }

  it('extracts in archive order after a matching selection proof and tracks offsets itself', async () => {
    const { worker, job, onMember } = start();
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'extractBatch', runs: [[{ path: 'a.bin', size: 3 }, { path: 'b.bin', size: 2 }]],
    });
    worker.emit('message', { type: 'selected', run: 0, ...listed() });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'proceed', run: 0 });
    worker.emit('message', { type: 'member', index: 0, offset: 0, length: 3 });
    worker.emit('message', { type: 'member', index: 1, offset: 3, length: 2 });
    worker.emit('message', { type: 'ran', run: 0, exitCode: 0, stdoutLength: 0, stderr: '' });
    const result = await job;
    expect(result.complete).toBe(true);
    // Reported in the caller's select() order.
    expect(result.members.map((member) => [member.index, member.entry.path, member.offset, member.length]))
      .toEqual([[0, 'b.bin', 3, 2], [1, 'a.bin', 0, 3]]);
    expect(onMember).toHaveBeenCalledTimes(2);
  });

  it('refuses members before the proof, out of order, oversized or repeated', async () => {
    const cases = [
      (worker) => worker.emit('message', { type: 'member', index: 0, offset: 0, length: 3 }),
      (worker) => {
        worker.emit('message', { type: 'selected', run: 0, ...listed() });
        worker.emit('message', { type: 'member', index: 0, offset: 1, length: 3 });
      },
      (worker) => {
        worker.emit('message', { type: 'selected', run: 0, ...listed() });
        worker.emit('message', { type: 'member', index: 0, offset: 0, length: 4 });
      },
      (worker) => {
        worker.emit('message', { type: 'selected', run: 0, ...listed() });
        worker.emit('message', { type: 'member', index: 0, offset: 0, length: 3 });
        worker.emit('message', { type: 'member', index: 0, offset: 3, length: 3 });
      },
    ];
    for (const act of cases) {
      const { worker, job } = start();
      act(worker);
      await expectCode(job, 'PROTOCOL_ERROR');
    }
  });

  it('refuses a run whose selection proof does not list exactly its members', async () => {
    for (const members of [[BOTH[0]], [...BOTH, ['c.bin', 1, '00000000']], [BOTH[0], ['b.bin', 2, '00000000']]]) {
      const { worker, job } = start();
      worker.emit('message', { type: 'selected', run: 0, ...listed(members) });
      await expectCode(job, 'EXTRACTION_FAILED');
      expect(worker.postMessage).not.toHaveBeenCalledWith({ type: 'proceed', run: 0 });
    }
  });

  it('distinguishes clean, member-level and archive-level outcomes', async () => {
    const finish = (ran, members = [[0, 0, 3], [1, 3, 2]]) => {
      const { worker, job } = start();
      worker.emit('message', { type: 'selected', run: 0, ...listed() });
      for (const [index, offset, length] of members) worker.emit('message', { type: 'member', index, offset, length });
      worker.emit('message', { type: 'ran', run: 0, stdoutLength: 0, ...ran });
      return job;
    };
    await expectCode(finish({ exitCode: 0, stderr: '' }, [[0, 0, 3]]), 'EXTRACTION_FAILED');
    await expectCode(finish({ exitCode: 0, stderr: '' }, [[0, 0, 3], [1, 3, 1]]), 'EXTRACTION_FAILED');
    const partial = await finish({ exitCode: 2, stderr: 'ERROR: Data Error : b.bin' }, [[0, 0, 3]]);
    expect(partial.complete).toBe(false);
    expect(partial.members[0]).toMatchObject({ offset: null, length: null });
    await expectCode(finish({ exitCode: 2, stderr: 'ERROR: Wrong password : b.bin' }), 'ARCHIVE_ENCRYPTED');
  });

  it('validates the chosen members against the job listing', async () => {
    await expectCode(start(() => ['a.bin', 'a.bin']).job, 'INVALID_ARGUMENT');
    await expectCode(start(() => ['missing.bin']).job, 'MEMBER_NOT_FOUND');
    await expectCode(start(() => ['../a.bin']).job, 'ARCHIVE_ENTRY_UNSAFE');
    await expectCode(start(() => []).job, 'INVALID_ARGUMENT');
  });

  it('writes nothing past the declared size and reports disk-write failures (real worker)', async () => {
    const wasmModule = await WebAssembly.compile(fs.readFileSync(path.join(VENDOR, '7zz.wasm')));
    const run = async (instruction, { readOnly = false, maxArgvBytes = BATCH_ARGV_BYTES } = {}) => {
      const input = await fs.promises.open(path.join(DECODER_FIXTURES, 'rar5-solid.rar'), 'r');
      const outputPath = path.join(stagingRoot, 'out-' + Math.random().toString(16).slice(2));
      fs.writeFileSync(outputPath, '');
      const output = fs.openSync(outputPath, readOnly ? 'r' : 'r+');
      const worker = new RealWorker(WORKER_URL, {
        workerData: {
          gluePath: path.join(VENDOR, '7zz.cjs'),
          wasmModule,
          fd: input.fd,
          inputSize: (await input.stat()).size,
          archiveType: 'Rar5',
          limits: { maxMemoryBytes: 64 * MIB, maxMemberBytes: 64 * MIB, maxListingBytes: MIB, maxLogBytes: 65536 },
          outputFd: output,
          batchLimits: { maxMembers: 1000, maxBytes: 64 * MIB, maxArgvBytes },
        },
      });
      const messages = [];
      const failed = new Promise((resolve) => {
        worker.on('message', (message) => {
          messages.push(message);
          if (message.type === 'listed') worker.postMessage(instruction);
          if (message.type === 'selected') worker.postMessage({ type: 'proceed', run: message.run });
          if (message.type === 'failed' || message.type === 'ran') resolve(message);
        });
      });
      try {
        return { first: await failed, size: fs.fstatSync(output).size };
      } finally {
        await worker.terminate();
        fs.closeSync(output);
        await input.close();
      }
    };
    const declared = (await withOpen(path.join(DECODER_FIXTURES, 'rar5-solid.rar'), async (openFile) => {
      const outputPath = path.join(stagingRoot, 'probe');
      fs.writeFileSync(outputPath, '');
      const fd = fs.openSync(outputPath, 'r+');
      try {
        return await extractOpenedArchiveBatch(openFile, {
          select: (listing) => listing.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
          outputFd: fd, maxMembers: 10, maxBytes: MIB,
        }, { format: 'rar' });
      } finally {
        fs.closeSync(fd);
      }
    })).members;
    expect(declared.every((member) => member.length === member.entry.size)).toBe(true);
    const [first] = declared;

    const short = await run({ type: 'extractBatch', runs: [[{ path: first.entry.path, size: first.entry.size - 1 }]] });
    expect(short.first).toMatchObject({ type: 'failed', code: 'OUTPUT_LIMIT_EXCEEDED' });
    expect(short.size).toBeLessThan(first.entry.size);

    const readOnly = await run({ type: 'extractBatch', runs: [[{ path: first.entry.path, size: first.entry.size }]] }, { readOnly: true });
    expect(readOnly.first).toMatchObject({ type: 'failed', code: 'OUTPUT_WRITE_FAILED' });

    const tooLong = await run({ type: 'extractBatch', runs: [[{ path: first.entry.path, size: first.entry.size }]] }, { maxArgvBytes: 100 });
    expect(tooLong.first).toMatchObject({ type: 'failed', code: 'PROTOCOL_ERROR' });
    expect(tooLong.size).toBe(0);

    // The worker counts argv as callMain allocates it: '7zz' first, then every argument, each
    // string with its terminator and the (argc + 1) pointer array rounded to 16 bytes.
    const stackBytes = (args) => {
      const all = ['7zz', ...args];
      const align = (bytes) => Math.ceil(bytes / 16) * 16;
      return align((all.length + 1) * 4) + all.reduce((sum, arg) => sum + align(Buffer.byteLength(arg) + 1), 0);
    };
    const common = ['-sccUTF-8', '-bsp0', '-bse2', '-pcreatorcrate-no-password', '-tRar5', '--', '/in/archive', first.entry.path];
    const exact = stackBytes(['x', '-o/out', '-aoa', '-bso0', '-spd', ...common]);
    expect(exact).toBeGreaterThan(stackBytes(['l', '-slt', '-spd', ...common]));
    const one = [[{ path: first.entry.path, size: first.entry.size }]];
    const under = await run({ type: 'extractBatch', runs: one }, { maxArgvBytes: exact - 1 });
    expect(under.first).toMatchObject({ type: 'failed', code: 'PROTOCOL_ERROR' });
    const fits = await run({ type: 'extractBatch', runs: one }, { maxArgvBytes: exact });
    expect(fits.first).toMatchObject({ type: 'ran', exitCode: 0 });
    expect(fits.size).toBe(first.entry.size);
  });
});
