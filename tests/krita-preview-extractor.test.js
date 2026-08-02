import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractKritaPreview,
  KritaPreviewExtractionError,
  KRITA_PREVIEW_LIMITS,
} from '../src/storage/krita-preview-extractor.js';
import { makeZip } from './helpers/zip-fixture.js';

async function withOpenArchive(bytes, callback) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-krita-extractor-'));
  const archivePath = path.join(tmpDir, 'document.kra');
  fs.writeFileSync(archivePath, bytes);
  const handle = fs.openSync(archivePath, 'r');
  const openFile = { handle, stat: fs.fstatSync(handle) };

  try {
    return await callback(openFile);
  } finally {
    fs.closeSync(handle);
    await new Promise((resolve) => setImmediate(resolve));
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 10,
    });
  }
}

async function expectUnavailable(bytes, options = {}) {
  await withOpenArchive(bytes, async (openFile) => {
    await expect(
      extractKritaPreview(openFile, options)
    ).rejects.toBeInstanceOf(KritaPreviewExtractionError);
  });
}

function entry(name, data = Buffer.from(name)) {
  return { name, data };
}

describe('extractKritaPreview', () => {
  it('chooses KRA mergedimage.png even when preview.png appears first', async () => {
    const archive = makeZip([
      entry('preview.png', Buffer.from('thumbnail')),
      entry('mergedimage.png', Buffer.from('merged')),
    ]);

    await withOpenArchive(archive, async (openFile) => {
      await expect(extractKritaPreview(openFile, { extension: 'kra' })).resolves.toEqual({
        bytes: Buffer.from('merged'),
        entryName: 'mergedimage.png',
        quality: 'merged',
      });
    });
  });

  it('falls back to KRA preview.png when mergedimage.png is absent', async () => {
    const archive = makeZip([entry('preview.png', Buffer.from('thumbnail'))]);

    await withOpenArchive(archive, async (openFile) => {
      await expect(extractKritaPreview(openFile, { extension: 'kra' })).resolves.toEqual({
        bytes: Buffer.from('thumbnail'),
        entryName: 'preview.png',
        quality: 'thumbnail',
      });
    });
  });

  it('reads a KRZ preview.png and returns thumbnail quality', async () => {
    const archive = makeZip([
      entry('mergedimage.png', Buffer.from('must-not-win')),
      { ...entry('preview.png', Buffer.from('krz-preview')), compression: 'deflate' },
    ]);

    await withOpenArchive(archive, async (openFile) => {
      await expect(extractKritaPreview(openFile, { extension: 'krz' })).resolves.toEqual({
        bytes: Buffer.from('krz-preview'),
        entryName: 'preview.png',
        quality: 'thumbnail',
      });
    });
  });

  it('does not require or choose mergedimage.png for KRZ', async () => {
    const archive = makeZip([entry('preview.png', Buffer.from('preview-only'))]);

    await withOpenArchive(archive, async (openFile) => {
      const result = await extractKritaPreview(openFile, { extension: 'krz' });
      expect(result.entryName).toBe('preview.png');
      expect(result.bytes).toEqual(Buffer.from('preview-only'));
    });
  });

  it('supports STORE entries', async () => {
    const archive = makeZip([entry('preview.png', Buffer.from('stored'))]);

    await withOpenArchive(archive, async (openFile) => {
      const result = await extractKritaPreview(openFile, { extension: 'kra' });
      expect(result.bytes).toEqual(Buffer.from('stored'));
    });
  });

  it('supports DEFLATE entries', async () => {
    const archive = makeZip([
      { ...entry('preview.png', Buffer.from('deflated preview')), compression: 'deflate' },
    ]);

    await withOpenArchive(archive, async (openFile) => {
      const result = await extractKritaPreview(openFile, { extension: 'kra' });
      expect(result.bytes).toEqual(Buffer.from('deflated preview'));
    });
  });

  it('requires exact root candidate names and ignores nested candidates', async () => {
    await expectUnavailable(makeZip([
      entry('folder/mergedimage.png', Buffer.from('nested')),
      entry('folder/preview.png', Buffer.from('nested')),
    ]), { extension: 'kra' });
  });

  it('rejects traversal and backslash entry names safely', async () => {
    await expectUnavailable(makeZip([entry('../mergedimage.png', Buffer.from('escape'))]), {
      extension: 'kra',
    });
    await expectUnavailable(makeZip([entry('folder\\mergedimage.png', Buffer.from('escape'))]), {
      extension: 'kra',
    });
  });

  it('rejects an archive with no eligible entry', async () => {
    await expectUnavailable(makeZip([entry('document.xml', Buffer.from('<doc/>'))]), {
      extension: 'kra',
    });
  });

  it('rejects malformed or truncated central-directory data', async () => {
    const archive = makeZip([entry('preview.png', Buffer.from('preview'))]);
    await expectUnavailable(archive.subarray(0, archive.length - 8), { extension: 'kra' });
  });

  it('rejects a truncated selected entry', async () => {
    await expectUnavailable(makeZip([
      {
        ...entry('preview.png'),
        compressedSize: 1_000_000,
        uncompressedSize: 1_000_000,
        compressedData: Buffer.alloc(0),
      },
    ]), { extension: 'kra' });
  });

  it('rejects an encrypted candidate', async () => {
    await expectUnavailable(makeZip([
      { ...entry('preview.png', Buffer.from('encrypted')), flags: 0x1 },
    ]), { extension: 'kra' });
  });

  it('rejects an unsupported compression method', async () => {
    await expectUnavailable(makeZip([
      { ...entry('preview.png', Buffer.from('unsupported')), compressionMethod: 12 },
    ]), { extension: 'kra' });
  });

  it('enforces the compressed-size limit before opening the candidate stream', async () => {
    await expectUnavailable(makeZip([
      entry('preview.png', Buffer.from('12345678')),
    ]), {
      extension: 'kra',
      limits: { maxCompressedBytes: 4 },
    });
  });

  it('enforces the uncompressed-size limit before opening the candidate stream', async () => {
    await expectUnavailable(makeZip([
      entry('preview.png', Buffer.from('12345678')),
    ]), {
      extension: 'kra',
      limits: { maxUncompressedBytes: 4 },
    });
  });

  it('enforces the compression-ratio limit', async () => {
    await expectUnavailable(makeZip([
      { ...entry('preview.png', Buffer.alloc(128, 0)), compression: 'deflate' },
    ]), {
      extension: 'kra',
      limits: { maxCompressionRatio: 2 },
    });
  });

  it('enforces the central-directory entry-count limit', async () => {
    await expectUnavailable(makeZip([
      entry('one.bin', Buffer.from('1')),
      entry('preview.png', Buffer.from('preview')),
    ]), {
      extension: 'kra',
      limits: { maxEntries: 1 },
    });
  });

  it('rejects streamed output that exceeds its declared size', async () => {
    await expectUnavailable(makeZip([
      {
        ...entry('preview.png', Buffer.alloc(128, 0)),
        compression: 'deflate',
        uncompressedSize: 8,
      },
    ]), { extension: 'kra' });
  });

  it('rejects streamed output that exceeds its configured bound', async () => {
    await expectUnavailable(makeZip([
      entry('preview.png', Buffer.alloc(16, 0)),
    ]), {
      extension: 'kra',
      limits: { maxUncompressedBytes: 8 },
    });
  });

  it('preserves the caller descriptor after successful extraction', async () => {
    const archive = makeZip([entry('preview.png', Buffer.from('preview'))]);

    await withOpenArchive(archive, async (openFile) => {
      await extractKritaPreview(openFile, { extension: 'kra' });
      expect(fs.fstatSync(openFile.handle).isFile()).toBe(true);
    });
  });

  it('preserves the caller descriptor after failed extraction', async () => {
    const archive = makeZip([entry('preview.png', Buffer.from('preview'))]);

    await withOpenArchive(archive, async (openFile) => {
      await expect(
        extractKritaPreview(openFile, {
          extension: 'kra',
          limits: { maxUncompressedBytes: 1 },
        })
      ).rejects.toBeInstanceOf(KritaPreviewExtractionError);
      expect(fs.fstatSync(openFile.handle).isFile()).toBe(true);
    });
  });

  it('exports named production limits', () => {
    expect(KRITA_PREVIEW_LIMITS.maxEntries).toBeGreaterThan(0);
    expect(KRITA_PREVIEW_LIMITS.maxCompressedBytes).toBeGreaterThan(0);
    expect(KRITA_PREVIEW_LIMITS.maxUncompressedBytes).toBeGreaterThan(0);
    expect(KRITA_PREVIEW_LIMITS.maxCompressionRatio).toBeGreaterThan(0);
  });
});
