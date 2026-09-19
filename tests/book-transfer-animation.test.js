import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { parseBookImportArchive } from '../src/services/book-import-service.js';
import { BOOK_TRANSFER_LIMITS } from '../src/services/book-transfer-limits.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const ANIMATION_KEYS = ['animated', 'frameCount', 'delays', 'delay', 'loop', 'duration'];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readZipEntries(bytes) {
  const zip = await yauzl.fromBufferPromise(bytes, {
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const entries = new Map();
  try {
    for await (const entry of zip.eachEntry()) {
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      entries.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    zip.close();
  }
  return entries;
}

async function animationMetadata(bytes) {
  const metadata = await sharp(bytes, { animated: true }).metadata();
  return {
    format: metadata.format,
    frameCount: metadata.pages ?? 1,
    delays: metadata.delay,
    loop: metadata.loop,
    width: metadata.width,
    height: metadata.pageHeight ?? metadata.height,
    hasAlpha: metadata.hasAlpha,
  };
}

function expectV1Manifest(manifest, coverKeys, mediaKeys) {
  expect(manifest.format).toBe('creatorcrate-books');
  expect(manifest.version).toBe(1);
  expect(Object.keys(manifest).sort()).toEqual(['books', 'format', 'version']);
  expect(Object.keys(manifest.books[0].cover).sort()).toEqual([...coverKeys].sort());
  expect(Object.keys(manifest.books[0].cover.media).sort()).toEqual([...mediaKeys].sort());
  for (const key of ANIMATION_KEYS) {
    expect(Object.hasOwn(manifest, key)).toBe(false);
    expect(Object.hasOwn(manifest.books[0].cover, key)).toBe(false);
    expect(Object.hasOwn(manifest.books[0].cover.media, key)).toBe(false);
  }
}

function expectArchiveWithinLimits(archiveBytes, entries, manifestBytes, manifest, coverBytes) {
  expect(manifest.books.length).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.maximumBooks);
  expect(entries.size).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.maximumFileEntries);
  expect(manifestBytes.length).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.manifestBytes);
  expect(coverBytes.length).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.coverBytes);
  expect(manifestBytes.length + coverBytes.length)
    .toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.totalUncompressedBytes);
  expect(archiveBytes.length).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.compressedArchiveBytes);
}

function corruptCentralDirectoryCrc(bytes, entryName) {
  const result = Buffer.from(bytes);
  for (let offset = 0; offset <= result.length - 46; offset += 1) {
    if (result.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = result.readUInt16LE(offset + 28);
    const extraLength = result.readUInt16LE(offset + 30);
    const commentLength = result.readUInt16LE(offset + 32);
    const name = result.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      result.writeUInt32LE((result.readUInt32LE(offset + 16) + 1) >>> 0, offset + 16);
      return result;
    }
    offset += 45 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

describe('animated Book cover transfer integration', () => {
  let app;
  let db;
  let tmpDir;
  let projectsRoot;
  let exportTempRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-animation-transfer-'));
    projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    const previewRoot = path.join(appDataRoot, 'previews');
    exportTempRoot = path.join(tmpDir, 'exports');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });
    fs.mkdirSync(exportTempRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { appDataRoot, bookExportTempRoot: exportTempRoot },
    );
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function exportArchive(bookId) {
    const exported = await app.locals.bookExportService.createExport([bookId]);
    try {
      return fs.readFileSync(exported.filePath);
    } finally {
      exported.cleanup();
    }
  }

  it('round-trips the real animated Project preview through WP6 and WP7 unchanged', async () => {
    const sourceBytes = await makeAnimatedWebp(3, {
      width: 7,
      height: 5,
      delay: [80, 130, 210],
      loop: 5,
      transparent: true,
    });
    const project = app.locals.projectService.create({
      title: 'Animated Transfer Project',
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    const sourcePath = path.join(projectsRoot, project.project_dir, 'animated-cover.webp');
    fs.writeFileSync(sourcePath, sourceBytes);
    app.locals.assetScanner.scanProjectAssets(project.id);
    const asset = app.locals.assetScanner.listProjectAssets(project.id)
      .find((candidate) => candidate.relative_path === 'animated-cover.webp');
    expect(asset).toBeTruthy();

    const book = app.locals.bookService.createBook({ title: 'Animated Project Cover' });
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, asset.id);

    const preview = await app.locals.previewService.getPreview(project.id, asset.id);
    const previewBytes = fs.readFileSync(preview.path);
    const sourceAnimation = await animationMetadata(sourceBytes);
    const previewAnimation = await animationMetadata(previewBytes);
    expect(preview).toMatchObject({ status: 'ready', animated: true, width: 7, height: 5 });
    expect(sourceAnimation).toEqual({
      format: 'webp', frameCount: 3, delays: [80, 130, 210], loop: 5,
      width: 7, height: 5, hasAlpha: true,
    });
    expect(previewAnimation).toEqual(sourceAnimation);

    const prepareDerivativeResponse = app.locals.mediaService.prepareDerivativeResponse
      .bind(app.locals.mediaService);
    let preparedCleanup;
    const preparedResponseProbe = vi.spyOn(app.locals.mediaService, 'prepareDerivativeResponse')
      .mockImplementation(async (...args) => {
        const prepared = await prepareDerivativeResponse(...args);
        const cleanup = prepared.cleanup;
        preparedCleanup = vi.fn(() => cleanup());
        return { ...prepared, cleanup: preparedCleanup };
      });
    const archiveBytes = await exportArchive(book.id);
    const entries = await readZipEntries(archiveBytes);
    const manifestBytes = entries.get('creatorcrate-books.json');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const media = manifest.books[0].cover.media;
    const archiveCover = entries.get('covers/book-1/cover.webp');
    expectV1Manifest(manifest, ['kind', 'source', 'media'], ['path', 'mimeType', 'sizeBytes', 'sha256']);
    expect(manifest.books[0].cover).toMatchObject({
      kind: 'project_asset',
      source: {
        project: { slug: project.slug, title: project.title, projectType: project.project_type },
        relativePath: 'animated-cover.webp', filename: 'animated-cover.webp',
        extension: 'webp', mimeType: 'image/webp',
      },
      media: { path: 'covers/book-1/cover.webp', mimeType: 'image/webp' },
    });
    expect(archiveCover).toEqual(previewBytes);
    expect(media.sizeBytes).toBe(archiveCover.length);
    expect(media.sha256).toBe(sha256(archiveCover));
    expect(await animationMetadata(archiveCover)).toEqual(sourceAnimation);
    expectArchiveWithinLimits(archiveBytes, entries, manifestBytes, manifest, archiveCover);
    expect(preparedResponseProbe).toHaveBeenCalledWith('preview', project.id, asset.id);
    expect(preparedCleanup).toHaveBeenCalledOnce();

    const parsed = await parseBookImportArchive(archiveBytes);
    const parsedCover = parsed.books[0].cover.media.bytes;
    expect(parsedCover).toEqual(archiveCover);
    expect(parsedCover).not.toBe(archiveCover);
    expect(await animationMetadata(parsedCover)).toEqual(sourceAnimation);
    await expect(parseBookImportArchive(corruptCentralDirectoryCrc(
      archiveBytes,
      'covers/book-1/cover.webp',
    ))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('round-trips the original managed animated WebP through WP6 and WP7 unchanged', async () => {
    const sourceBytes = await makeAnimatedWebp(4, {
      width: 6,
      height: 4,
      delay: [60, 90, 140, 220],
      loop: 3,
      transparent: true,
    });
    const sourceAnimation = await animationMetadata(sourceBytes);
    const { record } = await app.locals.managedImageService.createCommittedImage({ bytes: sourceBytes });
    const stored = await app.locals.managedMediaService.resolveSource(record.id);
    expect(stored.bytes).toEqual(sourceBytes);
    expect(record).toMatchObject({
      mime_type: 'image/webp', width: 6, height: 4,
      size_bytes: sourceBytes.length, sha256: sha256(sourceBytes),
    });

    const book = app.locals.bookService.createBook({ title: 'Animated Managed Cover' });
    app.locals.bookPrimaryImageService.setManagedPrimaryImage(book.id, record.id);
    const archiveBytes = await exportArchive(book.id);
    const entries = await readZipEntries(archiveBytes);
    const manifestBytes = entries.get('creatorcrate-books.json');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const media = manifest.books[0].cover.media;
    const archiveCover = entries.get('covers/book-1/cover.webp');
    expectV1Manifest(
      manifest,
      ['kind', 'media'],
      ['path', 'mimeType', 'sizeBytes', 'width', 'height', 'sha256'],
    );
    expect(manifest.books[0].cover).toMatchObject({
      kind: 'managed',
      media: {
        path: 'covers/book-1/cover.webp', mimeType: 'image/webp',
        width: 6, height: 4, sizeBytes: sourceBytes.length, sha256: sha256(sourceBytes),
      },
    });
    expect(archiveCover).toEqual(sourceBytes);
    expect(archiveCover).toEqual(stored.bytes);
    expect(media.sizeBytes).toBe(archiveCover.length);
    expect(media.sha256).toBe(sha256(archiveCover));
    expect(await animationMetadata(archiveCover)).toEqual(sourceAnimation);
    expectArchiveWithinLimits(archiveBytes, entries, manifestBytes, manifest, archiveCover);

    const parsed = await parseBookImportArchive(archiveBytes);
    const parsedCover = parsed.books[0].cover.media.bytes;
    expect(parsedCover).toEqual(archiveCover);
    expect(parsedCover).toEqual(sourceBytes);
    expect(parsedCover).not.toBe(archiveCover);
    expect(await animationMetadata(parsedCover)).toEqual(sourceAnimation);
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects an over-frame-limit animated managed source before WP6', async () => {
    const unsafe = await makeAnimatedWebp(121, { width: 1, height: 1 });
    await expect(app.locals.managedImageService.createCommittedImage({ bytes: unsafe }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM managed_assets').get().count).toBe(0);
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });
});
