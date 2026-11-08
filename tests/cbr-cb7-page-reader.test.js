import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';

const tracked = vi.hoisted(() => ({ workers: [] }));

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

const { ArchiveDecoderError, inspectCbrCb7, readCbrCb7Page } = await import('../src/services/cbr-cb7-page-reader.js');
const { inspectCbz, readCbzPage } = await import('../src/services/cbz-page-reader.js');
const {
  extractArchiveMember,
  extractOpenedArchiveMember,
  listOpenedArchive,
} = await import('../src/services/archive-member-decoder.js');

const SevenZip = createRequire(import.meta.url)('7z-wasm');
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const DECODER_FIXTURES = fileURLToPath(new URL('./fixtures/archive-decoder/', import.meta.url));
const MIB = 1024 * 1024;

// Natural page order shared by every comic fixture below, whatever the stored order.
const PAGE_PATHS = ['ch1/page1.jpg', 'ch1/page2.png', 'ch1/page10.webp', 'ch2/page1.gif', 'ch2/page2.png', 'ch10/page1.png'];

let tempDir;
const files = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cbr-cb7-reader-'));
  // Gradient pixels compress well, so LZMA2/RAR members are genuinely compressed.
  const gradient = (width, height, seed) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) & 0xff;
    return sharp(raw, { raw: { width, height, channels: 3 } });
  };
  files.jpeg = await gradient(48, 64, 10).jpeg().toBuffer();
  files.png = await gradient(48, 64, 20).png({ compressionLevel: 0 }).toBuffer();
  files.webp = await gradient(48, 64, 30).webp({ lossless: true }).toBuffer();
  files.bigPng = await gradient(96, 128, 40).png({ compressionLevel: 0 }).toBuffer();
  files.animatedGif = await sharp([
    { create: { width: 16, height: 24, channels: 3, background: '#ff0000' } },
    { create: { width: 16, height: 24, channels: 3, background: '#00ff00' } },
  ], { join: { animated: true } }).gif({ loop: 0 }).toBuffer();
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
});

beforeEach(() => {
  tracked.workers.length = 0;
});

// The comic layout: pages out of natural order, nested folders, junk, metadata, a nested
// archive and one page whose content is not an image.
function comicEntries() {
  return [
    ['ch1/page10.webp', files.webp],
    ['ch2/page1.gif', files.animatedGif],
    ['ch1/page1.jpg', files.jpeg],
    ['ch2/page2.png', Buffer.from('this is not a png image, only text bytes. '.repeat(20))],
    ['ch1/page2.png', files.png],
    ['__MACOSX/ch1/._page1.jpg', Buffer.from('AppleDouble')],
    ['ch1/._page2.png', Buffer.from('AppleDouble')],
    ['.DS_Store', Buffer.from('ds')],
    ['ComicInfo.xml', Buffer.from('<ComicInfo/>')],
    ['Thumbs.db', Buffer.from('thumbs')],
    ['extras/nested.cbz', makeZip([{ name: 'inner.png', data: files.png }])],
    ['notes.txt', Buffer.from('notes')],
    ['ch10/page1.png', files.bigPng],
  ];
}

// Builds a 7z with the 7z-wasm writer CreatorCrate already depends on. links are
// [linkName, target] pairs stored as symbolic links (-snl).
async function make7z(entries, switches = [], links = []) {
  const module = await SevenZip({ print() {}, printErr() {} });
  module.FS.mkdirTree('/w');
  module.FS.chdir('/w');
  for (const [name, data] of entries) {
    const dir = path.posix.dirname(name);
    if (dir !== '.') module.FS.mkdirTree('/w/' + dir);
    module.FS.writeFile('/w/' + name, data);
  }
  for (const [name, target] of links) module.FS.symlink(target, '/w/' + name);
  const names = [...entries.map(([name]) => name), ...links.map(([name]) => name)];
  const code = module.callMain([
    'a', '-t7z', '-snl', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-bsp0', '-bso0', '-bse0', ...switches, '/out.7z', ...names,
  ]);
  if (code !== 0) throw new Error('7z-wasm failed with ' + code);
  return Buffer.from(module.FS.readFile('/out.7z'));
}

let counter = 0;
function writeTemp(bytes, extension) {
  counter += 1;
  const target = path.join(tempDir, 'comic-' + counter + extension);
  fs.writeFileSync(target, bytes);
  return target;
}

// Opens like openAssetFileAsync (FileHandle) or openAssetFile (number) and closes afterwards.
async function withOpen(file, callback, { sync = false } = {}) {
  if (sync) {
    const fd = fs.openSync(file, 'r');
    try {
      return await callback({ handle: fd, stat: fs.fstatSync(fd) });
    } finally {
      fs.closeSync(fd);
    }
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    return await callback({ handle, stat: await handle.stat() });
  } finally {
    await handle.close();
  }
}

async function codeOf(promise) {
  const caught = await promise.then(() => null, (error) => error);
  expect(caught).toBeInstanceOf(ArchiveDecoderError);
  return caught.code;
}

async function readAll(openFile, format, count) {
  const results = [];
  for (let position = 1; position <= count; position += 1) {
    results.push(await readCbrCb7Page(openFile, position, { format }).then((value) => value, (error) => error));
  }
  return results;
}

function expectWorkersReleased() {
  expect(tracked.workers.length).toBeGreaterThan(0);
  for (const worker of tracked.workers) expect(worker.threadId).toBe(-1);
}

const comic = (name) => path.join(COMICS, name);
const decoderFixture = (name) => path.join(DECODER_FIXTURES, name);

describe('CBR comics (RAR4/RAR5, compressed and solid)', () => {
  const pageBytes = new Map();

  it.each([
    ['comic-rar4.cbr', 'rar4', false],
    ['comic-rar4-solid.cbr', 'rar4', true],
    ['comic-rar5.cbr', 'rar5', false],
    ['comic-rar5-solid.cbr', 'rar5', true],
  ])('catalogs and reads every page of %s', async (name, container, solid) => {
    await withOpen(comic(name), async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cbr' });
      expect(catalog).toMatchObject({ format: 'cbr', container, solid, entryCount: 13, pageCount: 6, hasPages: true });
      expect(catalog.pages.map((page) => page.member.path)).toEqual(PAGE_PATHS);
      expect(catalog.pages.map((page) => page.position)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(catalog.pages[5]).toMatchObject({
        name: 'page1.png', extension: 'png', declaredFormat: 'png', declaredMimeType: 'image/png',
        compressionMethod: null, uncompressedSize: 37134, problem: null,
      });
      // Really compressed: the 37 KiB uncompressed PNG is stored in well under 1 KiB.
      expect(catalog.pages[5].compressedSize).toBeLessThan(1024);
      expect(Object.isFrozen(catalog.pages[0])).toBe(true);

      const results = await readAll(openFile, 'cbr', 6);
      expect(results.map((result) => result.image?.mimeType ?? result.code)).toEqual([
        'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'PAGE_INVALID_IMAGE', 'image/png',
      ]);
      expect(results[3].image).toMatchObject({ animated: true, frameCount: 2, width: 16, height: 24 });
      expect(results[5].image).toMatchObject({ width: 96, height: 128, animated: false });
      for (const result of results) {
        if (!result.bytes) continue;
        expect(result.bytes.length).toBe(result.page.uncompressedSize);
        // Every RAR variant yields byte-identical pages.
        const key = result.page.member.path;
        if (pageBytes.has(key)) expect(result.bytes.equals(pageBytes.get(key))).toBe(true);
        else pageBytes.set(key, result.bytes);
      }
    });
    expectWorkersReleased();
  });

  it('reads first and last pages through a numeric descriptor (openAssetFile)', async () => {
    await withOpen(comic('comic-rar5-solid.cbr'), async (openFile) => {
      expect((await readCbrCb7Page(openFile, 1, { format: 'cbr' })).page.member.path).toBe('ch1/page1.jpg');
      expect((await readCbrCb7Page(openFile, 6, { format: 'cbr' })).image.format).toBe('png');
      expect(await codeOf(readCbrCb7Page(openFile, 7, { format: 'cbr' }))).toBe('PAGE_NOT_FOUND');
      expect(await codeOf(readCbrCb7Page(openFile, 0, { format: 'cbr' }))).toBe('PAGE_NOT_FOUND');
      expect(await codeOf(readCbrCb7Page(openFile, '1', { format: 'cbr' }))).toBe('PAGE_NOT_FOUND');
    }, { sync: true });
  });

  it('keeps positions when one member of a non-solid archive is damaged', async () => {
    const bytes = fs.readFileSync(comic('comic-rar5.cbr'));
    // The last stored member (ch10/page1.png) ends just before the end-of-archive header.
    bytes[bytes.length - 60] ^= 0x55;
    await withOpen(writeTemp(bytes, '.cbr'), async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cbr' });
      expect(catalog.pages.map((page) => page.member.path)).toEqual(PAGE_PATHS);
      const results = await readAll(openFile, 'cbr', 6);
      expect(results.map((result) => result.code ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok', 'PAGE_INVALID_IMAGE', 'PAGE_CORRUPT']);
      expect(results[5].message).not.toMatch(/[\\/]|Data Error|CRC Failed/i);
    });
  });

  it('keeps earlier stream members readable when a solid RAR is damaged', async () => {
    const bytes = fs.readFileSync(comic('comic-rar5-solid.cbr'));
    // Inside the solid stream near ch1/page2.png and ch1/page10.webp (stored last but one/three).
    bytes[bytes.length - 300] ^= 0x55;
    await withOpen(writeTemp(bytes, '.cbr'), async (openFile) => {
      const results = await readAll(openFile, 'cbr', 6);
      expect(results.map((result) => result.code ?? 'ok')).toEqual(['ok', 'PAGE_CORRUPT', 'PAGE_CORRUPT', 'ok', 'PAGE_INVALID_IMAGE', 'ok']);
    });
  });

  it('rejects damaged headers, truncation and mislabelled containers at archive level', async () => {
    const bytes = fs.readFileSync(comic('comic-rar4.cbr'));
    const header = Buffer.from(bytes);
    header[1800] ^= 0x55;
    await withOpen(writeTemp(header, '.cbr'), async (openFile) => {
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr' }))).toBe('ARCHIVE_CORRUPT');
      expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cbr' }))).toBe('ARCHIVE_CORRUPT');
    });
    await withOpen(writeTemp(bytes.subarray(0, 1500), '.cbr'), async (openFile) => {
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr' }))).toBe('ARCHIVE_CORRUPT');
    });
    await withOpen(comic('comic-rar4.cbr'), async (openFile) => {
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cb7' }))).toBe('UNSUPPORTED_FORMAT');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbz' }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(inspectCbrCb7(openFile, {}))).toBe('INVALID_ARGUMENT');
    });
    await withOpen(writeTemp(makeZip([{ name: '1.png', data: files.png }]), '.cbr'), async (openFile) => {
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr' }))).toBe('UNSUPPORTED_FORMAT');
    });
  });

  it('keeps A1 refusals for encrypted, multi-volume, unsafe and ambiguous archives', async () => {
    const cases = [
      ['rar5-encrypted.rar', 'cbr', 'ARCHIVE_ENCRYPTED'],
      ['rar4-header-encrypted.rar', 'cbr', 'ARCHIVE_ENCRYPTED'],
      ['rar5-multivolume.part01.rar', 'cbr', 'ARCHIVE_MULTIVOLUME'],
      ['unsafe-path.7z', 'cb7', 'ARCHIVE_ENTRY_UNSAFE'],
      ['duplicate-names.7z', 'cb7', 'ARCHIVE_ENTRY_AMBIGUOUS'],
    ];
    for (const [name, format, code] of cases) {
      await withOpen(decoderFixture(name), async (openFile) => {
        expect(await codeOf(inspectCbrCb7(openFile, { format }))).toBe(code);
        expect(await codeOf(readCbrCb7Page(openFile, 1, { format }))).toBe(code);
      });
    }
    expectWorkersReleased();
  });

  it('reports archives without pages, ignoring links, directories and non-images', async () => {
    for (const name of ['rar4-compressed.rar', 'rar5-compressed.rar', 'rar5-symlink.rar']) {
      await withOpen(decoderFixture(name), async (openFile) => {
        const catalog = await inspectCbrCb7(openFile, { format: 'cbr' });
        expect(catalog).toMatchObject({ pageCount: 0, hasPages: false, pages: [] });
        expect(catalog.entryCount).toBeGreaterThan(0);
        expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cbr' }))).toBe('PAGE_NOT_FOUND');
      });
    }
  });
});

describe('CB7 comics (7z, compressed and solid)', () => {
  it.each([
    ['non-solid', ['-m0=lzma2', '-ms=off'], false],
    ['solid', ['-m0=lzma2', '-ms=on'], true],
  ])('catalogs and reads a %s 7z comic', async (label, switches, solid) => {
    const archive = writeTemp(await make7z(comicEntries(), switches), '.cb7');
    const source = new Map(comicEntries());
    await withOpen(archive, async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cb7' });
      expect(catalog).toMatchObject({ format: 'cb7', container: '7z', solid, pageCount: 6 });
      expect(catalog.pages.map((page) => page.member.path)).toEqual(PAGE_PATHS);
      const results = await readAll(openFile, 'cb7', 6);
      expect(results.map((result) => result.image?.format ?? result.code)).toEqual(['jpeg', 'png', 'webp', 'gif', 'PAGE_INVALID_IMAGE', 'png']);
      for (const result of results.filter((value) => value.bytes)) {
        expect(result.bytes.equals(source.get(result.page.member.path))).toBe(true);
      }
    });
    expectWorkersReleased();
  });

  it('reads a single-page comic and keeps a zero-byte page in place', async () => {
    await withOpen(writeTemp(await make7z([['only.jpg', files.jpeg]]), '.cb7'), async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cb7' });
      expect(catalog).toMatchObject({ pageCount: 1, pages: [{ position: 1, name: 'only.jpg' }] });
      expect((await readCbrCb7Page(openFile, 1, { format: 'cb7' })).bytes.equals(files.jpeg)).toBe(true);
      expect(await codeOf(readCbrCb7Page(openFile, 2, { format: 'cb7' }))).toBe('PAGE_NOT_FOUND');
    });
    const withBlank = await make7z([['1.png', Buffer.alloc(0)], ['2.png', files.png]]);
    await withOpen(writeTemp(withBlank, '.cb7'), async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cb7' });
      expect(catalog.pages.map((page) => page.problem)).toEqual(['PAGE_INVALID_IMAGE', null]);
      expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cb7' }))).toBe('PAGE_INVALID_IMAGE');
      expect((await readCbrCb7Page(openFile, 2, { format: 'cb7' })).page.position).toBe(2);
    });
  });

  it('never treats a symbolic link as a page and reports archives without pages', async () => {
    const linked = await make7z([['1.png', files.png], ['ComicInfo.xml', Buffer.from('<x/>')]], [], [['2.png', '1.png']]);
    await withOpen(writeTemp(linked, '.cb7'), async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cb7' });
      expect(catalog).toMatchObject({ entryCount: 3, pageCount: 1 });
      expect(catalog.pages[0].member.path).toBe('1.png');
    });
    const noPages = await make7z([['ComicInfo.xml', Buffer.from('<x/>')], ['readme.txt', Buffer.from('hi')]], [], [['link.png', 'readme.txt']]);
    await withOpen(writeTemp(noPages, '.cb7'), async (openFile) => {
      expect(await inspectCbrCb7(openFile, { format: 'cb7' })).toMatchObject({ pageCount: 0, hasPages: false });
    });
  });

  it('serves the content type, not the extension, and enforces image limits', async () => {
    const archive = await make7z([['1.jpg', files.png], ['2.png', files.bigPng]]);
    await withOpen(writeTemp(archive, '.cb7'), async (openFile) => {
      expect((await readCbrCb7Page(openFile, 1, { format: 'cb7' })).image.mimeType).toBe('image/png');
      expect(await codeOf(readCbrCb7Page(openFile, 2, { format: 'cb7', limits: { maxImagePixels: 10_000 } }))).toBe('IMAGE_LIMIT_EXCEEDED');
      expect(await codeOf(readCbrCb7Page(openFile, 2, { format: 'cb7', limits: { maxImageDimension: 100 } }))).toBe('IMAGE_LIMIT_EXCEEDED');
    });
  });

  it('isolates a damaged member of a non-solid 7z without renumbering', async () => {
    const entries = [['1.png', files.png], ['2.png', files.bigPng], ['3.png', files.png]];
    const bytes = await make7z(entries, ['-m0=lzma2', '-ms=off']);
    // Non-solid 7z packs each member's stream in order right after the 32-byte signature header.
    const listing = await withOpen(writeTemp(bytes, '.7z'), (openFile) => listOpenedArchive(openFile, { format: '7z' }));
    let offset = 32;
    for (const entry of listing.entries) {
      if (entry.path === '2.png') break;
      offset += entry.packedSize;
    }
    const target = listing.entries.find((entry) => entry.path === '2.png');
    bytes[offset + Math.floor(target.packedSize / 2)] ^= 0x55;
    await withOpen(writeTemp(bytes, '.cb7'), async (openFile) => {
      const results = await readAll(openFile, 'cb7', 3);
      expect(results.map((result) => result.code ?? result.page.position)).toEqual([1, 'PAGE_CORRUPT', 3]);
    });
  });
});

describe('catalog compatibility with CBZ', () => {
  it('produces the same pages, order and image results for the same comic', async () => {
    const entries = comicEntries();
    const zip = makeZip(entries.map(([name, data]) => ({ name, data, compression: 'deflate' })));
    const sevenZip = await make7z(entries, ['-ms=on']);
    await withOpen(writeTemp(zip, '.cbz'), async (cbzFile) => {
      await withOpen(writeTemp(sevenZip, '.cb7'), async (cb7File) => {
        const cbz = await inspectCbz(cbzFile);
        const cb7 = await inspectCbrCb7(cb7File, { format: 'cb7' });
        expect(cb7.pageCount).toBe(cbz.pageCount);
        // Every CBZ page field exists on CBR/CB7 pages; `modified` is the only addition.
        expect(Object.keys(cb7.pages[0]).sort()).toEqual([...Object.keys(cbz.pages[0]), 'modified'].sort());
        const shared = (page) => ({
          position: page.position, path: page.member.path, name: page.name, extension: page.extension,
          declaredFormat: page.declaredFormat, declaredMimeType: page.declaredMimeType,
          uncompressedSize: page.uncompressedSize, crc32: page.crc32, problem: page.problem,
        });
        expect(cb7.pages.map(shared)).toEqual(cbz.pages.map(shared));
        for (const position of [1, 4, 6]) {
          const fromCbz = await readCbzPage(cbzFile, position);
          const fromCb7 = await readCbrCb7Page(cb7File, position, { format: 'cb7' });
          expect(fromCb7.image).toEqual(fromCbz.image);
          expect(fromCb7.bytes.equals(fromCbz.bytes)).toBe(true);
        }
        expect(await codeOf(readCbrCb7Page(cb7File, 5, { format: 'cb7' }))).toBe(await codeOf(readCbzPage(cbzFile, 5)));
      });
    });
  });
});

describe('resource limits, cancellation and source authority', () => {
  let largePrefix;
  beforeAll(async () => {
    // A solid block whose only page sits after 32 MiB of zeros compressed with a 32 MiB
    // dictionary: reading the page decodes the whole prefix and needs about 39 MiB of decoder memory.
    largePrefix = writeTemp(await make7z(
      [['a-zeros.bin', new Uint8Array(32 * MIB)], ['b-page.png', files.png]],
      ['-m0=lzma2:d=32m', '-mmf=hc4', '-ms=on'],
    ), '.cb7');
  }, 30000);

  it('passes A1 memory, member, listing, entry and input limits through unchanged', async () => {
    await withOpen(largePrefix, async (openFile) => {
      const catalog = await inspectCbrCb7(openFile, { format: 'cb7' });
      expect(catalog).toMatchObject({ solid: true, pageCount: 1 });
      expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cb7', limits: { maxMemoryBytes: 32 * MIB } }))).toBe('MEMORY_LIMIT_EXCEEDED');
      expect((await readCbrCb7Page(openFile, 1, { format: 'cb7' })).bytes.equals(files.png)).toBe(true);
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cb7', limits: { maxMemoryBytes: 8 * MIB } }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cb7', limits: { maxMemoryBytes: 512 * MIB } }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cb7', limits: { bogus: 1 } }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cb7', limits: { maxPages: 0 } }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cb7', limits: { maxTotalUncompressedBytes: 32 * MIB } })))
        .toBe('EXPANSION_LIMIT_EXCEEDED');
    });
    expectWorkersReleased();

    await withOpen(comic('comic-rar5.cbr'), async (openFile) => {
      const small = await inspectCbrCb7(openFile, { format: 'cbr', limits: { maxMemberBytes: 1000 } });
      expect(small.pages.map((page) => page.problem)).toEqual([null, 'MEMBER_LIMIT_EXCEEDED', null, null, null, 'MEMBER_LIMIT_EXCEEDED']);
      expect(await codeOf(readCbrCb7Page(openFile, 6, { format: 'cbr', limits: { maxMemberBytes: 1000 } }))).toBe('MEMBER_LIMIT_EXCEEDED');
      expect((await readCbrCb7Page(openFile, 1, { format: 'cbr', limits: { maxMemberBytes: 1000 } })).image.format).toBe('jpeg');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr', limits: { maxEntries: 12 } }))).toBe('ENTRY_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr', limits: { maxListingBytes: 512 } }))).toBe('LISTING_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr', limits: { maxInputBytes: 1000 } }))).toBe('INPUT_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbrCb7(openFile, { format: 'cbr', limits: { maxPages: 5 } }))).toBe('PAGE_LIMIT_EXCEEDED');
    });
  }, 30000);

  it('cancels and times out running reads, releasing workers but not the caller descriptor', async () => {
    await withOpen(largePrefix, async (openFile) => {
      expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cb7', signal: AbortSignal.abort() }))).toBe('CANCELLED');
      expect(tracked.workers).toHaveLength(0);

      const controller = new AbortController();
      const pending = readCbrCb7Page(openFile, 1, { format: 'cb7', signal: controller.signal });
      // Abort while the worker is decoding the 32 MiB solid prefix.
      const poll = setInterval(() => {
        if (tracked.workers.length > 0) {
          clearInterval(poll);
          setTimeout(() => controller.abort(), 20);
        }
      }, 1);
      expect(await codeOf(pending)).toBe('CANCELLED');
      expectWorkersReleased();

      tracked.workers.length = 0;
      expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cb7', limits: { timeoutMs: 40 } }))).toBe('TIMEOUT');
      expectWorkersReleased();

      // The caller's descriptor is untouched and still usable for the next read.
      expect(fs.fstatSync(openFile.handle.fd).size).toBe(openFile.stat.size);
      expect((await readCbrCb7Page(openFile, 1, { format: 'cb7' })).bytes.equals(files.png)).toBe(true);
    });
  }, 30000);

  it('refuses a descriptor that no longer matches the stat the caller authorized', async () => {
    const archive = writeTemp(fs.readFileSync(comic('comic-rar5.cbr')), '.cbr');
    await withOpen(archive, async (openFile) => {
      const moved = { ...openFile, stat: { ...openFile.stat, size: openFile.stat.size, mtimeMs: openFile.stat.mtimeMs + 1 } };
      expect(await codeOf(inspectCbrCb7(moved, { format: 'cbr' }))).toBe('INPUT_CHANGED');
      fs.appendFileSync(archive, 'appended');
      expect(await codeOf(readCbrCb7Page(openFile, 1, { format: 'cbr' }))).toBe('INPUT_CHANGED');
    });
    expect(await codeOf(inspectCbrCb7(null, { format: 'cbr' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(inspectCbrCb7({ handle: -1, stat: { size: 1 } }, { format: 'cbr' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(inspectCbrCb7({ handle: 3, stat: {} }, { format: 'cbr' }))).toBe('INVALID_ARGUMENT');
  });
});

describe('A1 opened-archive selection hook', () => {
  it('extracts the member a selector picks from the job listing and keeps every A1 check', async () => {
    await withOpen(comic('comic-rar5-solid.cbr'), async (openFile) => {
      const seen = [];
      const result = await extractOpenedArchiveMember(openFile, (listing, checkpoint) => {
        checkpoint();
        seen.push(listing.solid, listing.entries.length, Object.isFrozen(listing.entries[0]));
        return listing.entries.find((entry) => entry.path.endsWith('page10.webp')).path;
      }, { format: 'rar' });
      expect(seen).toEqual([true, 13, true]);
      expect(result).toMatchObject({ format: 'rar5', solid: true, entry: { path: 'ch1/page10.webp', size: 64 } });

      const error = new ArchiveDecoderError('PAGE_NOT_FOUND', 'none');
      expect(await codeOf(extractOpenedArchiveMember(openFile, () => { throw error; }, { format: 'rar' }))).toBe('PAGE_NOT_FOUND');
      expect(await codeOf(extractOpenedArchiveMember(openFile, () => 'ch1', { format: 'rar' }))).toBe('MEMBER_NOT_FOUND');
      expect(await codeOf(extractOpenedArchiveMember(openFile, () => '../x.png', { format: 'rar' }))).toBe('ARCHIVE_ENTRY_UNSAFE');
      expect(await codeOf(extractOpenedArchiveMember(openFile, () => 42, { format: 'rar' }))).toBe('ARCHIVE_ENTRY_UNSAFE');
      expect(await codeOf(extractOpenedArchiveMember(openFile, undefined, { format: 'rar' }))).toBe('INVALID_ARGUMENT');
    });
    // The path-based API keeps accepting member paths only.
    expect(await codeOf(extractArchiveMember(comic('comic-rar5.cbr'), () => 'ch1/page1.jpg', { format: 'rar' }))).toBe('INVALID_ARGUMENT');
    expectWorkersReleased();
  });
});
