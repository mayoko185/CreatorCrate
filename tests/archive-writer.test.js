import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { encode as encodeBmp } from '@nktkas/bmp';
import { deriveArchivePlans, normalizeArchiveOptions, writeArchiveFile } from '../src/services/archive-processing.js';
import { renderArchiveImage } from '../src/services/asset-processing-service.js';
import { read7zArchiveEntries } from '../src/services/watermark-7z.js';
import { read7zEntryNames } from './helpers/seven-zip.js';

function readZipEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.push({ name: entry.fileName, buffer: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

async function makeSource() {
  const pixels = Buffer.alloc(48 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i * 17 + (i >> 4)) % 256;
    pixels[i + 1] = (i * 31 + (i >> 6)) % 256;
    pixels[i + 2] = (i * 47 + (i >> 8)) % 256;
    pixels[i + 3] = 100 + (i % 156);
  }
  return sharp(pixels, { raw: { width: 48, height: 32, channels: 4 } }).png().toBuffer();
}

function webpChunks(buffer) {
  const chunks = [];
  for (let offset = 12; offset + 8 <= buffer.length;) {
    chunks.push(buffer.toString('ascii', offset, offset + 4));
    const size = buffer.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

describe('archive writer and member rendering', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-archive-writer-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it.each([
    ['zip', 'jpeg', false], ['7z', 'webp', false],
    ['cbz', 'png', false], ['cb7', 'webp', true],
  ])('round trips genuine %s containers with %s members', async (archiveFormat, imageFormat, lossless) => {
    const sourceBuffer = await makeSource();
    const bmp = Buffer.from(encodeBmp({
      width: 2, height: 2, channels: 3,
      data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    }, { bitsPerPixel: 24 }));
    const sources = [
      { sourceRelativePath: 'Final/nested/second.png', sourceBuffer, sourceExtension: 'png' },
      { sourceRelativePath: 'Final/first.bmp', sourceBuffer: bmp, sourceExtension: 'bmp' },
    ];
    for (const source of sources) {
      const sourcePath = path.join(directory, source.sourceRelativePath);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, source.sourceBuffer);
    }
    const entry = { archiveFormat, imageFormat,
      ...(imageFormat === 'webp' ? { lossless, quality: 73 } : {}) };
    const [plan] = deriveArchivePlans({
      sources, options: normalizeArchiveOptions({ archives: [entry] }), projectSlug: 'book',
    });
    const entries = [];
    for (const member of plan.entries) {
      entries.push({ name: member.name, buffer: await renderArchiveImage({ ...member.source, ...plan }) });
    }
    const outputPath = path.join(directory, plan.relativePath);
    if (archiveFormat.startsWith('cb')) {
      const descriptor = fs.openSync(outputPath, 'wx');
      try {
        await writeArchiveFile(outputPath, plan.format, entries, { descriptor });
        expect(fs.fstatSync(descriptor).size).toBeGreaterThan(0);
      } finally { fs.closeSync(descriptor); }
    } else {
      await writeArchiveFile(outputPath, plan.format, entries);
    }
    const archive = fs.readFileSync(outputPath);
    const sevenZip = archiveFormat === '7z' || archiveFormat === 'cb7';
    expect(archive.subarray(0, sevenZip ? 6 : 4)).toEqual(sevenZip
      ? Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) : Buffer.from('PK\x03\x04', 'binary'));
    const actual = sevenZip ? await read7zArchiveEntries(archive) : await readZipEntries(outputPath);
    expect(sevenZip ? await read7zEntryNames(archive) : actual.map(({ name }) => name))
      .toEqual(entries.map(({ name }) => name));
    expect(actual.map(({ name }) => name).sort()).toEqual(entries.map(({ name }) => name).sort());
    for (const member of actual) {
      expect(member.buffer).toEqual(entries.find(({ name }) => name === member.name).buffer);
      expect((await sharp(member.buffer).metadata()).format).toBe(imageFormat);
    }
    const bmpMember = actual.find(({ name }) => name.startsWith('Final/first.'));
    expect(await sharp(bmpMember.buffer).metadata()).toMatchObject({ width: 2, height: 2 });
    if (imageFormat === 'png' || lossless) {
      expect(await sharp(bmpMember.buffer).removeAlpha().raw().toBuffer()).toEqual(Buffer.from([
        255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0,
      ]));
    }
    for (const source of sources) {
      expect(fs.readFileSync(path.join(directory, source.sourceRelativePath))).toEqual(source.sourceBuffer);
    }
  });

  it.each(['zip', 'cbz', '7z', 'cb7'])('preserves nonalphabetical and interleaved nested member order in %s', async (format) => {
    const names = ['page_03.png', 'page_01.png', 'page_02.png',
      'z/nested/page_03.png', 'a/page_01.png', 'z/nested/page_02.png', '-page.png'];
    const entries = await Promise.all(names.map(async (name, index) => ({
      name,
      buffer: await sharp({ create: { width: index + 1, height: 2, channels: 4,
        background: { r: index * 30, g: 20, b: 40, alpha: 1 } } }).png().toBuffer(),
    })));
    const outputPath = path.join(directory, `ordered.${format}`);
    await writeArchiveFile(outputPath, format, entries);
    const archive = fs.readFileSync(outputPath);
    const sevenZip = format === '7z' || format === 'cb7';
    const actual = sevenZip ? await read7zArchiveEntries(archive) : await readZipEntries(outputPath);
    expect(sevenZip ? await read7zEntryNames(archive) : actual.map((entry) => entry.name)).toEqual(names);
    expect(actual).toHaveLength(entries.length);
    for (const entry of actual) expect(entry.buffer).toEqual(entries.find(({ name }) => name === entry.name).buffer);
    expect(archive.subarray(0, sevenZip ? 6 : 4)).toEqual(sevenZip
      ? Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) : Buffer.from('PK\x03\x04', 'binary'));
  });

  it.each(['rar', 'cbr', 'tar', 'ZIP', undefined])('rejects unsupported container %s before creating a file', async (format) => {
    const output = path.join(directory, 'unsupported.zip');
    await expect(writeArchiveFile(output, format, [{ name: 'page.jpg', buffer: Buffer.from('page') }]))
      .rejects.toMatchObject({ code: 'INVALID_ARCHIVE_FORMAT' });
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each(['jpeg', 'webp'])('uses selected %s quality including both endpoints', async (imageFormat) => {
    const sourceBuffer = await makeSource();
    const results = [];
    for (const quality of [1, 100]) {
      const output = await renderArchiveImage({ sourceBuffer, imageFormat, quality });
      const pipeline = sharp(sourceBuffer, { animated: false }).rotate();
      const expected = imageFormat === 'jpeg' ? pipeline.jpeg({ quality })
        : pipeline.webp({ quality, lossless: false });
      expect(output).toEqual(await expected.toBuffer());
      if (imageFormat === 'webp') expect(webpChunks(output)).toContain('VP8 ');
      results.push(output);
    }
    expect(results[1].length).toBeGreaterThan(results[0].length);
  });

  it('writes lossless WebP pixels and transparency without applying lossy quality', async () => {
    const sourceBuffer = await makeSource();
    const render = (quality) => renderArchiveImage({ sourceBuffer, imageFormat: 'webp', lossless: true, quality });
    const output = await render(1);
    expect(output).toEqual(await render(100));
    expect(webpChunks(output)).toContain('VP8L');
    expect(webpChunks(output)).not.toContain('VP8 ');
    expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(sourceBuffer).raw().toBuffer());
    expect(await sharp(output).metadata()).toMatchObject({ hasAlpha: true });
  });

  it('writes PNG bytes and preserves alpha without a quality setting', async () => {
    const sourceBuffer = await makeSource();
    const output = await renderArchiveImage({ sourceBuffer, imageFormat: 'png' });
    expect(output.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(sourceBuffer).raw().toBuffer());
    expect(await sharp(output).metadata()).toMatchObject({ hasAlpha: true });
  });

  it('preserves automatic orientation and renders only the first animated/multipage frame', async () => {
    const oriented = await sharp(await makeSource()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const rotated = await renderArchiveImage({ sourceBuffer: oriented, imageFormat: 'png' });
    expect(await sharp(rotated).metadata()).toMatchObject({ width: 32, height: 48 });
    const frames = Buffer.from([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0]);
    for (const format of ['gif', 'tiff']) {
      const animated = await sharp(frames, { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } })
        [format]().toBuffer();
      expect((await sharp(animated).metadata()).pages).toBe(2);
      const output = await renderArchiveImage({ sourceBuffer: animated, imageFormat: 'png' });
      expect(await sharp(output).metadata()).toMatchObject({ width: 2, height: 1 });
      expect(await sharp(output).removeAlpha().raw().toBuffer())
        .toEqual(await sharp(animated, { page: 0 }).removeAlpha().raw().toBuffer());
    }
  });

  it('rejects unsupported member formats instead of falling back to JPEG', async () => {
    await expect(renderArchiveImage({ sourceBuffer: await makeSource(), imageFormat: 'gif' }))
      .rejects.toMatchObject({ code: 'INVALID_ARCHIVE_IMAGE_FORMAT' });
  });
});
