import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import {
  ArchiveDecoderError,
  compareComicPaths,
  inspectCbz,
  readCbzPage,
} from '../src/services/cbz-page-reader.js';
import { makeZip } from './helpers/zip-fixture.js';

const images = {};

beforeAll(async () => {
  const base = () => sharp({ create: { width: 4, height: 3, channels: 3, background: '#336699' } });
  images.png = await base().png().toBuffer();
  images.jpeg = await base().jpeg().toBuffer();
  images.webp = await base().webp().toBuffer();
  images.gif = await base().gif().toBuffer();
});

async function withOpenArchive(bytes, callback, { async: useFileHandle = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cbz-reader-'));
  const archivePath = path.join(tmpDir, 'comic.cbz');
  fs.writeFileSync(archivePath, bytes);
  let openFile;
  if (useFileHandle) {
    const handle = await fs.promises.open(archivePath, 'r');
    openFile = { handle, stat: await handle.stat() };
  } else {
    const handle = fs.openSync(archivePath, 'r');
    openFile = { handle, stat: fs.fstatSync(handle) };
  }
  try {
    return await callback(openFile);
  } finally {
    if (useFileHandle) await openFile.handle.close();
    else fs.closeSync(openFile.handle);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
}

async function codeOf(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ArchiveDecoderError);
    return err.code;
  }
  throw new Error('expected rejection');
}

const page = (name, data = images.png, extra = {}) => ({ name, data, ...extra });
const names = (catalog) => catalog.pages.map((p) => p.member.path);

describe('compareComicPaths', () => {
  it('orders digit runs numerically, folders naturally, and ties deterministically', () => {
    const paths = ['page10.jpg', 'Page2.jpg', 'page1.jpg', 'ch10/01.jpg', 'ch2/01.jpg', 'page02.jpg', 'page.jpg'];
    expect([...paths].sort(compareComicPaths)).toEqual([
      'ch2/01.jpg', 'ch10/01.jpg', 'page.jpg', 'page1.jpg', 'Page2.jpg', 'page02.jpg', 'page10.jpg',
    ]);
    // Total order: no distinct pair compares equal, and the result is input-order independent.
    expect([...paths].reverse().sort(compareComicPaths)).toEqual([...paths].sort(compareComicPaths));
    expect(compareComicPaths('A.jpg', 'a.jpg')).not.toBe(0);
    expect(compareComicPaths('p99999999999999999999.jpg', 'p100000000000000000000.jpg')).toBeLessThan(0);
  });
});

describe('inspectCbz', () => {
  it('catalogs supported image pages in natural order regardless of ZIP order', async () => {
    const zip = makeZip([
      page('page10.png'),
      page('page2.jpg', images.jpeg, { compression: 'deflate' }),
      page('page1.webp', images.webp),
      page('page3.gif', images.gif),
    ]);
    await withOpenArchive(zip, async (openFile) => {
      const catalog = await inspectCbz(openFile);
      expect(catalog).toMatchObject({ format: 'cbz', entryCount: 4, pageCount: 4, hasPages: true });
      expect(names(catalog)).toEqual(['page1.webp', 'page2.jpg', 'page3.gif', 'page10.png']);
      expect(catalog.pages.map((p) => p.position)).toEqual([1, 2, 3, 4]);
      expect(catalog.pages[1]).toMatchObject({
        member: { entryIndex: 1, path: 'page2.jpg' },
        name: 'page2.jpg', extension: 'jpg', declaredMimeType: 'image/jpeg',
        compressionMethod: 'deflate', uncompressedSize: images.jpeg.length, problem: null,
      });
      expect(Object.isFrozen(catalog.pages[0])).toBe(true);
    });
  });

  it('supports nested page folders and excludes metadata, junk, links and non-images', async () => {
    const symlink = { versionMadeBy: 0x0314, externalFileAttributes: (0o120777 << 16) >>> 0 };
    const zip = makeZip([
      page('Vol 1/', Buffer.alloc(0)),
      page('Vol 1/ch10/001.png'),
      page('Vol 1/ch2/001.png'),
      page('Vol 1/ch2/002.png'),
      page('__MACOSX/Vol 1/._001.png'),
      page('Vol 1/._001.png'),
      page('.hidden/001.png'),
      page('Vol 1/.DS_Store', Buffer.from('x')),
      page('ComicInfo.xml', Buffer.from('<ComicInfo/>')),
      page('Thumbs.db', Buffer.from('x')),
      page('extras.zip', Buffer.from('PK')),
      page('link.png', Buffer.from('Vol 1/ch2/001.png'), symlink),
    ]);
    await withOpenArchive(zip, async (openFile) => {
      expect(names(await inspectCbz(openFile))).toEqual(['Vol 1/ch2/001.png', 'Vol 1/ch2/002.png', 'Vol 1/ch10/001.png']);
    });
  });

  it('reports empty archives and archives without pages', async () => {
    for (const zip of [makeZip([]), makeZip([page('readme.txt', Buffer.from('hi')), page('dir/', Buffer.alloc(0))])]) {
      await withOpenArchive(zip, async (openFile) => {
        expect(await inspectCbz(openFile)).toMatchObject({ pageCount: 0, hasPages: false, pages: [] });
      });
    }
  });

  it('rejects unsafe and ambiguous member names', async () => {
    const cases = [
      [[page('../escape.png')], 'ARCHIVE_ENTRY_UNSAFE'],
      [[page('/abs.png')], 'ARCHIVE_ENTRY_UNSAFE'],
      [[page('C:/drive.png')], 'ARCHIVE_ENTRY_UNSAFE'],
      [[page('dir\\back.png')], 'ARCHIVE_ENTRY_UNSAFE'],
      [[page('a//b.png')], 'ARCHIVE_ENTRY_UNSAFE'],
      [[page('ctl\u0001.png')], 'ARCHIVE_ENTRY_UNSAFE'],
      [[page('dup.png'), page('dup.png')], 'ARCHIVE_ENTRY_AMBIGUOUS'],
      [[page('Case.png'), page('case.png')], 'ARCHIVE_ENTRY_AMBIGUOUS'],
      [[page('caf\u00e9.png'), page('cafe\u0301.png')], 'ARCHIVE_ENTRY_AMBIGUOUS'],
      [[page('x'), page('x/1.png')], 'ARCHIVE_ENTRY_AMBIGUOUS'],
      [[page('x'.repeat(40) + '.png')], 'ARCHIVE_ENTRY_UNSAFE', { maxPathLength: 20 }],
    ];
    for (const [entries, code, limits] of cases) {
      await withOpenArchive(makeZip(entries), async (openFile) => {
        expect(await codeOf(inspectCbz(openFile, { limits }))).toBe(code);
      });
    }
  });

  it('rejects encrypted, non-ZIP, truncated and overlapping archives', async () => {
    const good = makeZip([page('1.png')]);
    const overlapping = makeZip([page('1.png'), page('2.png')]);
    // Point the second central entry at the first member's local header.
    const secondCentral = overlapping.lastIndexOf(Buffer.from('PK\x01\x02', 'binary'));
    overlapping.writeUInt32LE(0, secondCentral + 42);
    const cases = [
      // Traditional PKWARE encryption prefixes stored data with a 12-byte header.
      [makeZip([page('1.png', images.png, { flags: 0x801, compressedData: Buffer.concat([Buffer.alloc(12), images.png]) })]), 'ARCHIVE_ENCRYPTED'],
      [makeZip([page('1.png', images.png, { compressionMethod: 99 })]), 'ARCHIVE_ENCRYPTED'],
      [Buffer.from('Rar!\x1a\x07\x00 not a zip', 'binary'), 'UNSUPPORTED_FORMAT'],
      [good.subarray(0, good.length - 10), 'ARCHIVE_CORRUPT'],
      [makeZip([page('1.png')], { entryCount: 2 }), 'ARCHIVE_CORRUPT'],
      [overlapping, 'ARCHIVE_CORRUPT'],
    ];
    for (const [zip, code] of cases) {
      await withOpenArchive(zip, async (openFile) => {
        expect(await codeOf(inspectCbz(openFile))).toBe(code);
      });
    }
  });

  it('enforces input, entry, page and declared-expansion limits', async () => {
    const zip = makeZip([page('1.png'), page('2.png'), page('3.png')]);
    await withOpenArchive(zip, async (openFile) => {
      expect(await codeOf(inspectCbz(openFile, { limits: { maxInputBytes: zip.length - 1 } }))).toBe('INPUT_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbz(openFile, { limits: { maxEntries: 2 } }))).toBe('ENTRY_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbz(openFile, { limits: { maxPages: 2 } }))).toBe('PAGE_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbz(openFile, { limits: { maxTotalUncompressedBytes: images.png.length * 3 - 1 } })))
        .toBe('EXPANSION_LIMIT_EXCEEDED');
      expect(await codeOf(inspectCbz(openFile, { limits: { bogus: 1 } }))).toBe('INVALID_ARGUMENT');
    });
  });

  it('keeps oversized and unsupported pages in place with a problem code', async () => {
    const bomb = Buffer.alloc(2 * 1024 * 1024);
    const zip = makeZip([
      page('1.png'),
      page('2.png', bomb, { compression: 'deflate' }),
      page('3.png', images.png, { compressionMethod: 12, compressedData: images.png }),
      page('4.png'),
    ]);
    await withOpenArchive(zip, async (openFile) => {
      const catalog = await inspectCbz(openFile, { limits: { maxCompressionRatio: 100 } });
      expect(catalog.pages.map((p) => p.problem)).toEqual([null, 'EXPANSION_LIMIT_EXCEEDED', 'UNSUPPORTED_COMPRESSION', null]);
      const small = await inspectCbz(openFile, { limits: { maxMemberBytes: 1024 * 1024 } });
      expect(small.pages[1].problem).toBe('MEMBER_LIMIT_EXCEEDED');
      expect(await codeOf(readCbzPage(openFile, 2, { limits: { maxCompressionRatio: 100 } }))).toBe('EXPANSION_LIMIT_EXCEEDED');
      expect(await codeOf(readCbzPage(openFile, 3))).toBe('UNSUPPORTED_COMPRESSION');
      expect((await readCbzPage(openFile, 4)).page.member.path).toBe('4.png');
    });
  });
});

describe('readCbzPage', () => {
  it('reads each page by position with verified bytes and image metadata', async () => {
    const zip = makeZip([
      page('b/10.png', images.png, { compression: 'deflate' }),
      page('b/9.jpg', images.jpeg),
      page('a.webp', images.webp, { compression: 'deflate' }),
      page('c.gif', images.gif),
    ]);
    await withOpenArchive(zip, async (openFile) => {
      const results = [];
      for (let position = 1; position <= 4; position += 1) results.push(await readCbzPage(openFile, position));
      expect(results.map((r) => r.page.member.path)).toEqual(['a.webp', 'b/9.jpg', 'b/10.png', 'c.gif']);
      expect(results.map((r) => r.image.mimeType)).toEqual(['image/webp', 'image/jpeg', 'image/png', 'image/gif']);
      expect(results[2].bytes.equals(images.png)).toBe(true);
      expect(results[0].image).toMatchObject({ width: 4, height: 3, frameCount: 1, animated: false });
      expect(await codeOf(readCbzPage(openFile, 5))).toBe('PAGE_NOT_FOUND');
      expect(await codeOf(readCbzPage(openFile, 0))).toBe('PAGE_NOT_FOUND');
      expect(await codeOf(readCbzPage(openFile, '1'))).toBe('PAGE_NOT_FOUND');
    });
  });

  it('reads a single-page archive through an async FileHandle', async () => {
    await withOpenArchive(makeZip([page('only.jpg', images.jpeg)]), async (openFile) => {
      const result = await readCbzPage(openFile, 1);
      expect(result.page.position).toBe(1);
      expect(result.bytes.equals(images.jpeg)).toBe(true);
    }, { async: true });
  });

  it('flags animated GIF pages so the viewer can show a still frame', async () => {
    const frame = await sharp({ create: { width: 2, height: 4, channels: 3, background: '#0000ff' } }).raw().toBuffer();
    const gif = await sharp(frame, { raw: { width: 2, height: 4, channels: 3 } }).gif().toBuffer();
    const twoFrames = await sharp([
      { create: { width: 2, height: 4, channels: 3, background: '#ff0000' } },
      { create: { width: 2, height: 4, channels: 3, background: '#00ff00' } },
    ], { join: { animated: true } }).gif({ loop: 0 }).toBuffer();
    await withOpenArchive(makeZip([page('1.gif', gif), page('2.gif', twoFrames)]), async (openFile) => {
      expect((await readCbzPage(openFile, 1)).image).toMatchObject({ animated: false, frameCount: 1 });
      expect((await readCbzPage(openFile, 2)).image).toMatchObject({ format: 'gif', animated: true, frameCount: 2, height: 4 });
    });
  });

  it('detects CRC mismatches, size mismatches and corrupt deflate data without renumbering', async () => {
    const corruptDeflate = zlib.deflateRawSync(images.png);
    corruptDeflate[Math.floor(corruptDeflate.length / 2)] ^= 0xff;
    const zip = makeZip([
      page('1.png'),
      page('2.png', images.png, { declaredCrc32: 0x12345678 }),
      page('3.png', images.png, { compression: 'deflate', uncompressedSize: images.png.length - 1 }),
      page('4.png', images.png, { compression: 'deflate', uncompressedSize: images.png.length + 1 }),
      page('5.png', images.png, { compression: 'deflate', compressedData: corruptDeflate }),
      page('6.png'),
    ]);
    await withOpenArchive(zip, async (openFile) => {
      const catalog = await inspectCbz(openFile);
      expect(names(catalog)).toEqual(['1.png', '2.png', '3.png', '4.png', '5.png', '6.png']);
      for (const position of [2, 3, 4, 5]) {
        expect(await codeOf(readCbzPage(openFile, position))).toBe('PAGE_CORRUPT');
      }
      const last = await readCbzPage(openFile, 6);
      expect(last.page).toMatchObject({ position: 6, member: { path: '6.png' } });
    });
  });

  it('rejects a local header that disagrees with the central directory', async () => {
    const zip = makeZip([page('1.png'), page('2.png')]);
    // Rename the first member's local header only.
    zip.write('9', 30, 'latin1');
    await withOpenArchive(zip, async (openFile) => {
      expect(await codeOf(readCbzPage(openFile, 1))).toBe('PAGE_CORRUPT');
      expect((await readCbzPage(openFile, 2)).bytes.equals(images.png)).toBe(true);
    });
  });

  it('rejects invalid images, mislabeled content and oversized dimensions', async () => {
    const big = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#000' } }).png().toBuffer();
    const zip = makeZip([
      page('1.png', Buffer.from('not an image at all')),
      page('2.png', Buffer.concat([images.png.subarray(0, 8), Buffer.from('garbage-chunk-data')])),
      page('3.jpg', images.png),
      page('4.png', big),
      page('5.png', Buffer.alloc(0)),
    ]);
    await withOpenArchive(zip, async (openFile) => {
      expect(await codeOf(readCbzPage(openFile, 1))).toBe('PAGE_INVALID_IMAGE');
      expect(await codeOf(readCbzPage(openFile, 2))).toBe('PAGE_INVALID_IMAGE');
      // Content wins over the extension, so the served type is truthful.
      expect((await readCbzPage(openFile, 3)).image.mimeType).toBe('image/png');
      expect(await codeOf(readCbzPage(openFile, 4, { limits: { maxImagePixels: 50_000 } }))).toBe('IMAGE_LIMIT_EXCEEDED');
      expect(await codeOf(readCbzPage(openFile, 4, { limits: { maxImageDimension: 256 } }))).toBe('IMAGE_LIMIT_EXCEEDED');
      expect(await codeOf(readCbzPage(openFile, 5))).toBe('PAGE_INVALID_IMAGE');
    });
  });

  it('honours cancellation and deadlines and leaves the caller descriptor open and reusable', async () => {
    const large = await sharp({ create: { width: 1500, height: 1500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .png({ compressionLevel: 0 }).toBuffer();
    const zip = makeZip([page('1.png', large, { compression: 'deflate' }), page('2.png')]);
    await withOpenArchive(zip, async (openFile) => {
      const aborted = new AbortController();
      aborted.abort();
      expect(await codeOf(inspectCbz(openFile, { signal: aborted.signal }))).toBe('CANCELLED');

      // Abort once decompression is well inside the member data, and prove no positional read
      // on the caller's descriptor is still pending when the call settles.
      const midway = new AbortController();
      const realRead = fs.read;
      let inFlight = 0;
      let abortedAt = null;
      const spy = vi.spyOn(fs, 'read').mockImplementation((fd, buffer, offset, length, position, callback) => {
        if (abortedAt === null && position >= 256 * 1024 && position < zip.length - 64 * 1024) {
          abortedAt = position;
          midway.abort();
        }
        inFlight += 1;
        return realRead(fd, buffer, offset, length, position, (...args) => {
          inFlight -= 1;
          callback(...args);
        });
      });
      try {
        expect(await codeOf(readCbzPage(openFile, 1, { signal: midway.signal }))).toBe('CANCELLED');
        expect(abortedAt).not.toBeNull();
        expect(inFlight).toBe(0);
      } finally {
        spy.mockRestore();
      }

      expect(await codeOf(readCbzPage(openFile, 1, { limits: { timeoutMs: 1 } }))).toBe('TIMEOUT');

      // The descriptor is still owned by the caller and fully usable afterwards.
      expect(fs.fstatSync(typeof openFile.handle === 'number' ? openFile.handle : openFile.handle.fd).size).toBe(zip.length);
      expect((await readCbzPage(openFile, 1)).bytes.equals(large)).toBe(true);
    });
  });

  it('rejects descriptors that are not opened regular files', async () => {
    expect(await codeOf(inspectCbz(null))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(inspectCbz({ handle: -1, stat: { size: 0 } }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(inspectCbz({ handle: 3, stat: { size: 10, isFile: () => false } }))).toBe('INVALID_ARGUMENT');
  });
});
