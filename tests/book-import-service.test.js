import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  parseBookImportArchive,
  planBookImportTitles,
} from '../src/services/book-import-service.js';
import {
  BOOK_TRANSFER_LIMITS,
  isBookTransferUncompressedSizeAllowed,
} from '../src/services/book-transfer-limits.js';
import { BOOK_TITLE_MAX } from '../src/services/book-service.js';
import { validateManagedImageBuffer } from '../src/services/managed-image-service.js';
import { makeAnimatedWebp, makeSolidAnimatedWebp, setWebpCanvas,
  webpChunks } from './helpers/animated-webp.js';
import { makeZip } from './helpers/zip-fixture.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const WHEN = '2026-09-18 10:00:00';

function associations() {
  return {
    projects: [{ slug: 'portable-project', title: 'Portable Project', projectType: 'images' }],
    assets: [{
      project: { slug: 'portable-project', title: 'Portable Project', projectType: 'images' },
      relativePath: 'art/source.png', filename: 'source.png', extension: 'png', mimeType: 'image/png',
    }],
    unresolvedProjectCount: 1,
    unresolvedAssetCount: 2,
  };
}

function revision(key = 'revision-1') {
  return {
    key, title: 'Historical title', rawMarkdown: '# Old\n\n`001`', sourceUpdatedAt: WHEN,
    createdAt: WHEN, associations: associations(),
  };
}

function page(key, chapterKey = null) {
  return {
    key, chapterKey, title: `Page ${key}`, rawMarkdown: '# Current\n\n[link](/notes/123)',
    createdAt: WHEN, updatedAt: WHEN, associations: associations(), revisions: [revision()],
  };
}

function book(key = 'book-1', title = 'Book') {
  return {
    key, title, createdAt: WHEN, updatedAt: WHEN,
    rootContents: [
      { type: 'page', key: 'page-1' },
      { type: 'chapter', key: 'chapter-1' },
    ],
    chapters: [{ key: 'chapter-1', title: 'Empty-capable Chapter', createdAt: WHEN, updatedAt: WHEN, pageKeys: ['page-2'] }],
    pages: [page('page-1'), page('page-2', 'chapter-1')],
    previewSettings: { mode: 'selected', randomCount: 5, selectedPageKeys: ['page-2', 'page-1'] },
    cover: { kind: 'none' },
  };
}

function manifest(books = [book()]) {
  return { format: 'creatorcrate-books', version: 1, books };
}

function archive(value, entries = []) {
  return makeZip([
    { name: 'creatorcrate-books.json', data: `${JSON.stringify(value, null, 2)}\n` },
    ...entries,
  ]);
}

function clone(value) {
  return structuredClone(value);
}

function insertProject(db, title, slug) {
  return Number(db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
    VALUES (?, ?, '', '', 'tbd', 'images', NULL)
  `).run(title, slug).lastInsertRowid);
}

function insertAsset(db, projectId, relativePath, filename) {
  return Number(db.prepare(`
    INSERT INTO assets (
      project_id, relative_path, filename, extension, mime_type, size_bytes,
      modified_at, is_present, last_seen_at
    ) VALUES (?, ?, ?, 'png', 'image/png', 10, ?, 1, datetime('now'))
  `).run(projectId, relativePath, filename, WHEN).lastInsertRowid);
}

function withManagedCover(value, bytes, mimeType, width, height) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType];
  value.cover = {
    kind: 'managed',
    media: {
      path: `covers/${value.key}/cover.${extension}`, mimeType, sizeBytes: bytes.length, width, height,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  };
  return value;
}

function withProjectCover(value, bytes, path = `covers/${value.key}/cover.webp`, mimeType = 'image/webp') {
  value.cover = {
    kind: 'project_asset',
    source: associations().assets[0],
    media: {
      path, mimeType, sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  };
  return value;
}

function unixEntry(input, mode) {
  return {
    ...input,
    versionMadeBy: (3 << 8) | 20,
    externalFileAttributes: (mode << 16) >>> 0,
  };
}

async function readEntryMetadata(bytes) {
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
  const entries = [];
  for await (const entry of zip.eachEntry()) {
    entries.push({
      name: entry.fileName,
      host: entry.versionMadeBy >>> 8,
      mode: (entry.externalFileAttributes >>> 16) & 0xffff,
    });
  }
  return entries;
}

async function expectCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ name: 'BookImportError', code, status: 422 });
}

describe('Book import parser', () => {
  let tmpDir;
  let db;
  let app;
  let projectCoverBytes;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-import-'));
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'exports'), { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot: path.join(tmpDir, 'projects'), previewRoot: path.join(tmpDir, 'previews') },
      { appDataRoot, bookExportTempRoot: path.join(tmpDir, 'exports'), mediaService: {
        prepareDerivativeResponse: async () => ({ stream: Readable.from(projectCoverBytes), cleanup() {} }),
      } },
    );
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses an archive produced by the actual WP6 exporter without database or media mutation', async () => {
    const source = app.locals.bookService.createBook({ title: 'Exporter-compatible Book' });
    const projectId = insertProject(db, 'Portable Project', 'portable-project');
    const assetId = insertAsset(db, projectId, 'art/source.png', 'source.png');
    const chapter = app.locals.chapterService.createChapter({ bookId: source.id, title: 'Chapter' });
    const nested = app.locals.noteService.createNote({
      bookId: source.id, chapterId: chapter.id, title: 'Nested', content: '# Historical',
      projectIds: [projectId], assetIds: [assetId],
    });
    app.locals.noteService.updateNote(nested.id, {
      title: 'Nested', content: '# Exact\n\n`0007`', projectIds: [projectId], assetIds: [assetId],
    });
    const root = app.locals.noteService.createNote({
      bookId: source.id, title: 'Root', content: 'Root text', projectIds: [projectId], assetIds: [assetId],
    });
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(source.id, {
      mode: 'selected', randomCount: 3, selectedPageIds: [nested.id, root.id],
    });
    const before = {
      books: db.prepare('SELECT COUNT(*) AS count FROM books').get().count,
      chapters: db.prepare('SELECT COUNT(*) AS count FROM chapters').get().count,
      pages: db.prepare('SELECT COUNT(*) AS count FROM notes').get().count,
      revisions: db.prepare('SELECT COUNT(*) AS count FROM note_revisions').get().count,
      covers: db.prepare('SELECT COUNT(*) AS count FROM managed_assets').get().count,
    };

    const exported = await app.locals.bookExportService.createExport([source.id]);
    const result = await parseBookImportArchive(fs.readFileSync(exported.filePath));
    exported.cleanup();

    expect(result).toMatchObject({ format: 'creatorcrate-books', version: 1 });
    expect(result.books[0].rootContents.map((item) => item.type)).toEqual(['chapter', 'page']);
    expect(result.books[0].pages.map((item) => item.rawMarkdown)).toEqual(['# Exact\n\n`0007`', 'Root text']);
    expect(result.books[0].previewSettings.selectedPageKeys).toEqual(['page-1', 'page-2']);
    expect(result.books[0].pages[0].associations).toMatchObject({
      projects: [{ slug: 'portable-project' }],
      assets: [{ project: { slug: 'portable-project' }, relativePath: 'art/source.png' }],
    });
    expect(result.books[0].pages[0].revisions[0].associations).toMatchObject({
      projects: [{ slug: 'portable-project' }],
      assets: [{ project: { slug: 'portable-project' }, relativePath: 'art/source.png' }],
    });
    expect({
      books: db.prepare('SELECT COUNT(*) AS count FROM books').get().count,
      chapters: db.prepare('SELECT COUNT(*) AS count FROM chapters').get().count,
      pages: db.prepare('SELECT COUNT(*) AS count FROM notes').get().count,
      revisions: db.prepare('SELECT COUNT(*) AS count FROM note_revisions').get().count,
      covers: db.prepare('SELECT COUNT(*) AS count FROM managed_assets').get().count,
    }).toEqual(before);
    expect(fs.readdirSync(path.join(tmpDir, 'exports'))).toEqual([]);
  });

  it('parses actual WP6 managed and Project-backed covers without additional persistence', async () => {
    const managedBook = app.locals.bookService.createBook({ title: 'Managed cover Book' });
    const managedBytes = await sharp({
      create: { width: 9, height: 6, channels: 4, background: '#ff8844' },
    }).png().toBuffer();
    const { record } = await app.locals.managedImageService.createCommittedImage({ bytes: managedBytes });
    app.locals.bookPrimaryImageService.setManagedPrimaryImage(managedBook.id, record.id);

    const projectBook = app.locals.bookService.createBook({ title: 'Project cover Book' });
    const projectId = insertProject(db, 'Cover Project', 'cover-project');
    const assetId = insertAsset(db, projectId, 'art/cover.png', 'cover.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(projectBook.id, assetId);
    projectCoverBytes = await sharp({
      create: { width: 12, height: 8, channels: 4, background: '#336699' },
    }).webp().toBuffer();
    const before = {
      books: db.prepare('SELECT COUNT(*) AS count FROM books').get().count,
      covers: db.prepare('SELECT COUNT(*) AS count FROM managed_assets').get().count,
    };

    const exported = await app.locals.bookExportService.createExport([managedBook.id, projectBook.id]);
    const archiveBytes = fs.readFileSync(exported.filePath);
    const metadata = await readEntryMetadata(archiveBytes);
    expect(metadata).toEqual([
      { name: 'creatorcrate-books.json', host: 3, mode: 0o100664 },
      { name: 'covers/book-1/cover.png', host: 3, mode: 0o100664 },
      { name: 'covers/book-2/cover.webp', host: 3, mode: 0o100664 },
    ]);
    const parsed = await parseBookImportArchive(archiveBytes);
    exported.cleanup();

    expect(parsed.books[0].cover).toMatchObject({ kind: 'managed', media: { bytes: managedBytes } });
    expect(parsed.books[1].cover).toMatchObject({ kind: 'project_asset', media: { bytes: projectCoverBytes } });
    expect({
      books: db.prepare('SELECT COUNT(*) AS count FROM books').get().count,
      covers: db.prepare('SELECT COUNT(*) AS count FROM managed_assets').get().count,
    }).toEqual(before);
  });

  it('preserves Book order, mixed hierarchy, exact text, previews, revisions, and association descriptors', async () => {
    const first = book('book-a', 'First');
    const second = book('book-b', 'Second');
    second.chapters[0].pageKeys = [];
    second.pages = [page('page-1')];
    second.rootContents = [{ type: 'chapter', key: 'chapter-1' }, { type: 'page', key: 'page-1' }];
    second.previewSettings.selectedPageKeys = ['page-1'];
    const result = await parseBookImportArchive(archive(manifest([first, second])));
    expect(result.books.map((item) => item.key)).toEqual(['book-a', 'book-b']);
    expect(result.books[0].pages[0].rawMarkdown).toBe('# Current\n\n[link](/notes/123)');
    expect(result.books[0].pages[0].revisions[0].rawMarkdown).toBe('# Old\n\n`001`');
    expect(result.books[0].pages[0].associations).toEqual(associations());
    expect(result.books[1].chapters[0].pageKeys).toEqual([]);
  });

  it('accepts distinct portable Project identities within one Page association list', async () => {
    const source = manifest();
    source.books[0].pages[0].associations.projects.push({
      slug: 'second-project', title: 'Second Project', projectType: 'images',
    });

    const parsed = await parseBookImportArchive(archive(source));

    expect(parsed.books[0].pages[0].associations.projects.map((project) => project.slug))
      .toEqual(['portable-project', 'second-project']);
  });

  it('rejects duplicate portable Project identities within one Page association list', async () => {
    const source = manifest();
    source.books[0].pages[0].associations.projects.push({
      slug: 'portable-project', title: 'Different metadata', projectType: 'video',
    });

    await expectCode(parseBookImportArchive(archive(source)), 'INVALID_MANIFEST_SCHEMA');
  });

  it('accepts distinct portable Asset identities within one Page association list', async () => {
    const source = manifest();
    const original = source.books[0].pages[0].associations.assets[0];
    source.books[0].pages[0].associations.assets.push(
      { ...clone(original), project: { ...clone(original.project), slug: 'second-project' } },
      { ...clone(original), relativePath: 'art/other.png', filename: 'other.png' },
    );

    const parsed = await parseBookImportArchive(archive(source));

    expect(parsed.books[0].pages[0].associations.assets.map((asset) => [asset.project.slug, asset.relativePath]))
      .toEqual([
        ['portable-project', 'art/source.png'],
        ['second-project', 'art/source.png'],
        ['portable-project', 'art/other.png'],
      ]);
  });

  it('rejects duplicate portable Asset identities within one Page association list', async () => {
    const source = manifest();
    const original = source.books[0].pages[0].associations.assets[0];
    source.books[0].pages[0].associations.assets.push({
      ...clone(original), filename: 'different-metadata.png', mimeType: 'image/webp',
    });

    await expectCode(parseBookImportArchive(archive(source)), 'INVALID_MANIFEST_SCHEMA');
  });

  it.each([
    ['Project', (value) => value.projects.push(clone(value.projects[0]))],
    ['Asset', (value) => value.assets.push(clone(value.assets[0]))],
  ])('rejects a duplicate portable %s identity within one revision', async (_kind, duplicate) => {
    const source = manifest();
    duplicate(source.books[0].pages[0].revisions[0].associations);

    await expectCode(parseBookImportArchive(archive(source)), 'INVALID_MANIFEST_SCHEMA');
  });

  it('allows the same portable associations once in separate Pages and revisions', async () => {
    const source = manifest();
    source.books[0].pages[0].revisions.push(revision('revision-2'));

    await expect(parseBookImportArchive(archive(source))).resolves.toMatchObject({
      books: [{ pages: [
        { associations: associations(), revisions: [{ associations: associations() }, { associations: associations() }] },
        { associations: associations() },
      ] }],
    });
  });

  it('rejects a manifest containing zero Books as invalid schema', async () => {
    await expectCode(parseBookImportArchive(archive(manifest([]))), 'INVALID_MANIFEST_SCHEMA');
  });

  it('accepts an empty Book', async () => {
    const empty = book();
    Object.assign(empty, { rootContents: [], chapters: [], pages: [] });
    empty.previewSettings.selectedPageKeys = [];
    await expect(parseBookImportArchive(archive(manifest([empty])))).resolves.toMatchObject({ books: [{ key: 'book-1' }] });
  });

  it.each([
    '2026-09-18 10:00:00',
    '2024-02-29 00:00:00',
    '2000-02-29 23:59:59',
    '2026-04-30 12:34:56',
    '2026-12-31 23:59:59',
  ])('accepts and preserves valid WP6 timestamp %s', async (value) => {
    const source = manifest();
    source.books[0].createdAt = value;
    const parsed = await parseBookImportArchive(archive(source));
    expect(parsed.books[0].createdAt).toBe(value);
  });

  it.each([
    '2026-02-30 10:00:00',
    '2026-02-29 10:00:00',
    '2100-02-29 10:00:00',
    '2026-00-01 10:00:00',
    '2026-13-01 10:00:00',
    '2026-01-00 10:00:00',
    '2026-04-31 10:00:00',
    '2026-01-01 24:00:00',
    '2026-01-01 10:60:00',
    '2026-01-01 10:00:60',
    '2026-01-01T10:00:00',
    '2026-01-01 10:00:00Z',
    '2026-01-01 10:00:00.001',
  ])('rejects invalid or non-WP6 timestamp %s', async (value) => {
    const source = manifest();
    source.books[0].createdAt = value;
    await expectCode(parseBookImportArchive(archive(source)), 'INVALID_MANIFEST_SCHEMA');
  });

  it.each([
    ['Page updatedAt', (source) => { source.books[0].pages[0].updatedAt = '2026-02-30 10:00:00'; }],
    ['revision sourceUpdatedAt', (source) => { source.books[0].pages[0].revisions[0].sourceUpdatedAt = '2026-02-30 10:00:00'; }],
  ])('rejects the whole archive for an impossible %s', async (_label, mutate) => {
    const source = manifest([book('book-1', 'First'), book('book-2', 'Second')]);
    mutate(source);
    await expectCode(parseBookImportArchive(archive(source)), 'INVALID_MANIFEST_SCHEMA');
  });

  it.each([
    ['not a ZIP', Buffer.from('not a zip'), 'INVALID_ARCHIVE'],
    ['missing manifest', makeZip([{ name: 'payload.bin', data: 'x' }]), 'MISSING_MANIFEST'],
    ['malformed JSON', makeZip([{ name: 'creatorcrate-books.json', data: '{' }]), 'INVALID_MANIFEST_JSON'],
  ])('rejects %s', async (_label, bytes, code) => expectCode(parseBookImportArchive(bytes), code));

  it('rejects a syntactically valid manifest with a mismatched ZIP CRC', async () => {
    await expectCode(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json',
      data: `${JSON.stringify(manifest(), null, 2)}\n`,
      declaredCrc32: 0,
    }])), 'INVALID_ARCHIVE');
  });

  it.each(['managed', 'project_asset'])('rejects a %s cover with a mismatched ZIP CRC', async (kind) => {
    const bytes = kind === 'managed'
      ? await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } }).png().toBuffer()
      : await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } }).webp().toBuffer();
    const covered = kind === 'managed'
      ? withManagedCover(book(), bytes, 'image/png', 2, 2)
      : withProjectCover(book(), bytes);
    await expectCode(parseBookImportArchive(archive(manifest([covered]), [{
      name: covered.cover.media.path,
      data: bytes,
      declaredCrc32: 0,
    }])), 'INVALID_ARCHIVE');
  });

  it('accepts a valid high-bit ZIP CRC using unsigned comparison', async () => {
    let source = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    while (crc32(source) <= 0x7fffffff) source = Buffer.concat([source, Buffer.from(' ')]);
    expect(crc32(source)).toBeGreaterThan(0x7fffffff);
    await expect(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json', data: source,
    }]))).resolves.toMatchObject({ books: [{ key: 'book-1' }] });
  });

  it('distinguishes wrong format and unsupported version', async () => {
    await expectCode(parseBookImportArchive(archive({ ...manifest(), format: 'other' })), 'WRONG_FORMAT');
    await expectCode(parseBookImportArchive(archive({ ...manifest(), version: 2 })), 'UNSUPPORTED_VERSION');
  });

  it.each(['../escape', '/absolute', 'C:/drive', '\\\\server\\share', 'folder\\file'])('rejects unsafe entry path %s', async (name) => {
    await expectCode(parseBookImportArchive(makeZip([{ name, data: 'x' }])), 'UNSAFE_ENTRY_PATH');
  });

  it('accepts regular and unspecified file types but rejects Unix directories and special types', async () => {
    const source = `${JSON.stringify(manifest(), null, 2)}\n`;
    await expect(parseBookImportArchive(makeZip([
      unixEntry({ name: 'creatorcrate-books.json', data: source }, 0o100664),
    ]))).resolves.toMatchObject({ books: [{ key: 'book-1' }] });
    await expect(parseBookImportArchive(makeZip([
      unixEntry({ name: 'creatorcrate-books.json', data: source }, 0o664),
    ]))).resolves.toMatchObject({ books: [{ key: 'book-1' }] });

    for (const mode of [0o040755, 0o120777, 0o020666]) {
      await expectCode(parseBookImportArchive(makeZip([
        unixEntry({ name: 'creatorcrate-books.json', data: source }, mode),
      ])), 'UNSAFE_ENTRY_PATH');
    }
  });

  it('rejects a file-looking cover entry whose Unix metadata marks it as a directory', async () => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } }).png().toBuffer();
    const covered = withManagedCover(book(), bytes, 'image/png', 2, 2);
    await expectCode(parseBookImportArchive(makeZip([
      unixEntry({ name: 'creatorcrate-books.json', data: `${JSON.stringify(manifest([covered]), null, 2)}\n` }, 0o100664),
      unixEntry({ name: covered.cover.media.path, data: bytes }, 0o040755),
    ])), 'UNSAFE_ENTRY_PATH');
  });

  it('rejects duplicate, undeclared, missing, and unexpected media entries', async () => {
    const base = manifest();
    await expectCode(parseBookImportArchive(makeZip([
      { name: 'creatorcrate-books.json', data: JSON.stringify(base) },
      { name: 'creatorcrate-books.json', data: JSON.stringify(base) },
    ])), 'DUPLICATE_ARCHIVE_ENTRY');
    await expectCode(parseBookImportArchive(archive(base, [{ name: 'extra.bin', data: 'x' }])), 'UNDECLARED_ENTRY');

    const missing = clone(base);
    missing.books[0].cover = {
      kind: 'managed',
      media: { path: 'covers/book-1/cover.png', mimeType: 'image/png', sizeBytes: 1, width: 1, height: 1, sha256: '0'.repeat(64) },
    };
    await expectCode(parseBookImportArchive(archive(missing)), 'MISSING_MEDIA');
    await expectCode(parseBookImportArchive(archive(manifest(), [{ name: 'covers/book-1/cover.png', data: 'x' }])), 'UNDECLARED_ENTRY');
  });

  it('accepts managed and Project/Asset covers and returns owned verified bytes', async () => {
    const managedBytes = await sharp({ create: { width: 5, height: 4, channels: 4, background: '#112233' } }).png().toBuffer();
    const projectBytes = await sharp({ create: { width: 6, height: 3, channels: 4, background: '#445566' } }).webp().toBuffer();
    const managed = book('book-managed', 'Managed');
    managed.cover = {
      kind: 'managed',
      media: {
        path: 'covers/book-managed/cover.png', mimeType: 'image/png', sizeBytes: managedBytes.length,
        width: 5, height: 4, sha256: crypto.createHash('sha256').update(managedBytes).digest('hex'),
      },
    };
    const project = book('book-project', 'Project');
    project.cover = {
      kind: 'project_asset', source: associations().assets[0],
      media: {
        path: 'covers/book-project/cover.webp', mimeType: 'image/webp', sizeBytes: projectBytes.length,
        sha256: crypto.createHash('sha256').update(projectBytes).digest('hex'),
      },
    };
    const result = await parseBookImportArchive(archive(manifest([managed, project]), [
      { name: managed.cover.media.path, data: managedBytes },
      { name: project.cover.media.path, data: projectBytes },
    ]));
    expect(result.books[0].cover.media.bytes).toEqual(managedBytes);
    expect(result.books[1].cover.source).toEqual(associations().assets[0]);
    expect(result.books[1].cover.media.bytes).toEqual(projectBytes);
  });

  it.each([
    'covers/book-1/not-the-wp6-name.bin',
    'covers/book-1/cover.webp',
    'covers/book-2/cover.png',
  ])('rejects non-canonical managed cover path %s', async (mediaPath) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } }).png().toBuffer();
    const covered = withManagedCover(book(), bytes, 'image/png', 2, 2);
    covered.cover.media.path = mediaPath;
    await expectCode(parseBookImportArchive(archive(manifest([covered]), [
      { name: mediaPath, data: bytes },
    ])), 'INVALID_COVER_METADATA');
  });

  it.each([
    ['covers/book-1/not-the-wp6-name.webp', 'image/webp'],
    ['covers/book-1/cover.png', 'image/webp'],
    ['covers/book-1/cover.webp', 'image/png'],
  ])('rejects non-canonical Project cover path/type %s (%s)', async (mediaPath, mimeType) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } }).webp().toBuffer();
    const covered = withProjectCover(book(), bytes, mediaPath, mimeType);
    await expectCode(parseBookImportArchive(archive(manifest([covered]), [
      { name: mediaPath, data: bytes },
    ])), 'INVALID_COVER_METADATA');
  });

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ])('accepts valid managed %s content through the authoritative image policy', async (format, mimeType) => {
    const bytes = await sharp({
      create: { width: 7, height: 5, channels: 4, background: '#224466' },
    }).toFormat(format).toBuffer();
    const covered = withManagedCover(book(), bytes, mimeType, 7, 5);
    await expect(parseBookImportArchive(archive(manifest([covered]), [
      { name: covered.cover.media.path, data: bytes },
    ]))).resolves.toMatchObject({ books: [{ cover: { media: { bytes } } }] });
  });

  it('accepts an animation above 40M and maps one above 100M to invalid media', async () => {
    const bytes = await makeSolidAnimatedWebp(41, { width: 988, height: 988 });
    const covered = withProjectCover(book(), bytes);
    await expect(parseBookImportArchive(archive(manifest([covered]), [
      { name: covered.cover.media.path, data: bytes },
    ]))).resolves.toMatchObject({ books: [{ cover: { media: { bytes } } }] });

    const unsafe = setWebpCanvas(await makeAnimatedWebp(101, { width: 1, height: 1 }), 1000, 1000);
    const unsafeCover = withProjectCover(book(), unsafe);
    await expectCode(parseBookImportArchive(archive(manifest([unsafeCover]), [
      { name: unsafeCover.cover.media.path, data: unsafe },
    ])), 'INVALID_MEDIA_CONTENT');
  });

  it('fully decodes WP7 cover admission and rejects a pixel-corrupt later animation frame', async () => {
    const bytes = Buffer.from(await makeAnimatedWebp(2, { lossless: false, transparent: false }));
    const laterFrame = webpChunks(bytes).filter((chunk) => chunk.type === 'ANMF').at(-1);
    bytes.fill(0xff, laterFrame.start + 16 + 8 + 5, laterFrame.end);
    const covered = withProjectCover(book(), bytes);
    await expectCode(parseBookImportArchive(archive(manifest([covered]), [
      { name: covered.cover.media.path, data: bytes },
    ])), 'INVALID_MEDIA_CONTENT');
  });

  it('rejects PNG trailing data exactly as the authoritative managed-image validator does', async () => {
    const png = await sharp({
      create: { width: 5, height: 4, channels: 4, background: '#112233' },
    }).png().toBuffer();
    const valid = withManagedCover(book(), png, 'image/png', 5, 4);
    await expect(parseBookImportArchive(archive(manifest([valid]), [
      { name: valid.cover.media.path, data: png },
    ]))).resolves.toMatchObject({ books: [{ cover: { media: { bytes: png } } }] });

    const trailing = Buffer.concat([png, Buffer.from('trailing bytes')]);
    const invalidCover = withManagedCover(book(), trailing, 'image/png', 5, 4);
    await expect(validateManagedImageBuffer(trailing)).rejects.toMatchObject({
      name: 'ManagedImageError', code: 'INVALID_IMAGE',
    });
    await expectCode(parseBookImportArchive(archive(manifest([invalidCover]), [
      { name: invalidCover.cover.media.path, data: trailing },
    ])), 'INVALID_MEDIA_CONTENT');
  });

  it.each(['png', 'jpeg', 'webp'])('rejects truncated %s content', async (format) => {
    const complete = await sharp({
      create: { width: 100, height: 100, channels: 4, background: '#abcdef' },
    }).toFormat(format).toBuffer();
    const bytes = complete.subarray(0, Math.floor(complete.length * 0.75));
    const mimeType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
    const covered = withManagedCover(book(), bytes, mimeType, 100, 100);
    await expectCode(parseBookImportArchive(archive(manifest([covered]), [
      { name: covered.cover.media.path, data: bytes },
    ])), 'INVALID_MEDIA_CONTENT');
  });

  it('rejects cover size, digest, MIME/content, and ownership mismatches', async () => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } }).png().toBuffer();
    const base = manifest();
    base.books[0].cover = {
      kind: 'managed', media: {
        path: 'covers/book-1/cover.png', mimeType: 'image/png', sizeBytes: bytes.length,
        width: 2, height: 2, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const size = clone(base);
    size.books[0].cover.media.sizeBytes += 1;
    await expectCode(parseBookImportArchive(archive(size, [{ name: base.books[0].cover.media.path, data: bytes }])), 'MEDIA_SIZE_MISMATCH');
    const digest = clone(base);
    digest.books[0].cover.media.sha256 = '0'.repeat(64);
    await expectCode(parseBookImportArchive(archive(digest, [{ name: base.books[0].cover.media.path, data: bytes }])), 'MEDIA_HASH_MISMATCH');
    const content = clone(base);
    const fake = Buffer.alloc(bytes.length, 1);
    content.books[0].cover.media.sha256 = crypto.createHash('sha256').update(fake).digest('hex');
    await expectCode(parseBookImportArchive(archive(content, [{ name: base.books[0].cover.media.path, data: fake }])), 'INVALID_MEDIA_CONTENT');
    const mime = clone(base);
    mime.books[0].cover.media.mimeType = 'image/jpeg';
    mime.books[0].cover.media.path = 'covers/book-1/cover.jpg';
    await expectCode(parseBookImportArchive(archive(mime, [{ name: mime.books[0].cover.media.path, data: bytes }])), 'INVALID_MEDIA_CONTENT');
    const dimensions = clone(base);
    dimensions.books[0].cover.media.width = 3;
    await expectCode(parseBookImportArchive(archive(dimensions, [{ name: base.books[0].cover.media.path, data: bytes }])), 'INVALID_MEDIA_CONTENT');
    const owner = clone(base);
    owner.books[0].cover.media.path = 'covers/other/cover.png';
    await expectCode(parseBookImportArchive(archive(owner)), 'INVALID_COVER_METADATA');
  });

  it.each([
    ['Book', (value) => value.books.push(clone(value.books[0]))],
    ['Chapter', (value) => value.books[0].chapters.push(clone(value.books[0].chapters[0]))],
    ['Page', (value) => value.books[0].pages.push(clone(value.books[0].pages[0]))],
    ['revision', (value) => value.books[0].pages[0].revisions.push(clone(value.books[0].pages[0].revisions[0]))],
  ])('rejects duplicate %s keys in the WP6 scope', async (_label, mutate) => {
    const value = manifest();
    mutate(value);
    await expectCode(parseBookImportArchive(archive(value)), 'DUPLICATE_LOCAL_KEY');
  });

  it.each([
    ['dangling root reference', (value) => { value.books[0].rootContents[0].key = 'missing'; }],
    ['duplicate root placement', (value) => { value.books[0].rootContents.push(clone(value.books[0].rootContents[0])); }],
    ['wrong Chapter membership', (value) => { value.books[0].pages[1].chapterKey = 'other'; }],
    ['unaccounted Page', (value) => { value.books[0].rootContents.shift(); }],
  ])('rejects %s', async (_label, mutate) => {
    const value = manifest();
    mutate(value);
    await expectCode(parseBookImportArchive(archive(value)), 'INVALID_HIERARCHY_REFERENCE');
  });

  it('rejects dangling and duplicate selected-preview references', async () => {
    const dangling = manifest();
    dangling.books[0].previewSettings.selectedPageKeys = ['missing'];
    await expectCode(parseBookImportArchive(archive(dangling)), 'INVALID_PREVIEW_REFERENCE');
    const duplicate = manifest();
    duplicate.books[0].previewSettings.selectedPageKeys = ['page-1', 'page-1'];
    await expectCode(parseBookImportArchive(archive(duplicate)), 'INVALID_PREVIEW_REFERENCE');
  });

  it('rejects declared archive, entry-count, manifest, and actual/declaration limit violations', async () => {
    await expectCode(parseBookImportArchive(Buffer.alloc(BOOK_TRANSFER_LIMITS.compressedArchiveBytes + 1)), 'ARCHIVE_LIMIT_EXCEEDED');
    await expectCode(parseBookImportArchive(makeZip([], {
      entryCount: BOOK_TRANSFER_LIMITS.maximumFileEntries + 1,
    })), 'ARCHIVE_LIMIT_EXCEEDED');
    await expectCode(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json', data: Buffer.alloc(BOOK_TRANSFER_LIMITS.manifestBytes + 1),
    }])), 'ARCHIVE_LIMIT_EXCEEDED');
    await expectCode(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json', data: JSON.stringify(manifest()), uncompressedSize: 1,
    }])), 'INVALID_ARCHIVE');
  });

  it('accepts the maximum Book count and rejects one over the shared limit', async () => {
    const maximum = Array.from({ length: BOOK_TRANSFER_LIMITS.maximumBooks }, (_, index) => {
      const value = book(`book-${index + 1}`, `Book ${index + 1}`);
      Object.assign(value, { rootContents: [], chapters: [], pages: [] });
      value.previewSettings.selectedPageKeys = [];
      return value;
    });
    const parsed = await parseBookImportArchive(archive(manifest(maximum)));
    expect(parsed.books).toHaveLength(BOOK_TRANSFER_LIMITS.maximumBooks);
    expect(parsed.books.at(-1).key).toBe('book-256');
    maximum.push({ ...maximum[0], key: 'book-257', title: 'Book 257' });
    await expectCode(parseBookImportArchive(archive(manifest(maximum))), 'ARCHIVE_LIMIT_EXCEEDED');
  });

  it('accepts the reviewer manifest above 4 MiB under the shared 8 MiB bound', async () => {
    const value = book();
    value.chapters = [];
    value.pages = Array.from({ length: 42 }, (_, index) => ({
      ...page(`page-${index + 1}`),
      rawMarkdown: 'x'.repeat(102_400),
      revisions: [],
    }));
    value.rootContents = value.pages.map((item) => ({ type: 'page', key: item.key }));
    value.previewSettings = { mode: 'random', randomCount: 5, selectedPageKeys: [] };
    const bytes = Buffer.from(`${JSON.stringify(manifest([value]), null, 2)}\n`, 'utf8');
    expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes.length).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.manifestBytes);
    await expect(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json', data: bytes, compression: 'deflate',
    }]))).resolves.toMatchObject({ books: [{ pages: expect.any(Array) }] });
  });

  it('uses actual UTF-8 manifest bytes and the shared total-uncompressed boundary', async () => {
    const source = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    const atLimit = Buffer.concat([
      source,
      Buffer.alloc(BOOK_TRANSFER_LIMITS.manifestBytes - source.length, 0x20),
    ]);
    await expect(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json', data: atLimit, compression: 'deflate',
    }]))).resolves.toMatchObject({ books: [{ key: 'book-1' }] });
    await expectCode(parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json', data: Buffer.concat([atLimit, Buffer.from(' ')]), compression: 'deflate',
    }])), 'ARCHIVE_LIMIT_EXCEEDED');

    expect(isBookTransferUncompressedSizeAllowed(BOOK_TRANSFER_LIMITS.totalUncompressedBytes)).toBe(true);
    expect(isBookTransferUncompressedSizeAllowed(BOOK_TRANSFER_LIMITS.totalUncompressedBytes + 1)).toBe(false);
  });

  it('returns no partial result when a later Book is invalid', async () => {
    const invalidSecond = book('book-2', 'Second');
    invalidSecond.rootContents[0].key = 'missing';
    await expectCode(parseBookImportArchive(archive(manifest([book('book-1', 'First'), invalidSecond]))), 'INVALID_HIERARCHY_REFERENCE');
  });
});

describe('Book import title collision planner', () => {
  it('reserves case-sensitive names in manifest order without interpreting numeric suffixes', () => {
    expect(planBookImportTitles([
      { key: 'a', title: ' Book ' }, { key: 'b', title: 'Book' },
      { key: 'c', title: 'Name-1' }, { key: 'd', title: 'book' },
    ], ['Book', 'Name-1'])).toEqual([
      { sourceKey: 'a', sourceTitle: ' Book ', destinationTitle: 'Book-1' },
      { sourceKey: 'b', sourceTitle: 'Book', destinationTitle: 'Book-2' },
      { sourceKey: 'c', sourceTitle: 'Name-1', destinationTitle: 'Name-1-1' },
      { sourceKey: 'd', sourceTitle: 'book', destinationTitle: 'book' },
    ]);
  });

  it('fits deterministic suffixes within the reusable title maximum without splitting surrogate pairs', () => {
    const full = 'A'.repeat(BOOK_TITLE_MAX);
    const emojiBoundary = `${'A'.repeat(BOOK_TITLE_MAX - 3)}😀B`;
    const fullPlan = planBookImportTitles([{ key: 'full', title: full }], [full]);
    const emojiPlan = planBookImportTitles([{ key: 'emoji', title: emojiBoundary }], [emojiBoundary]);
    const plans = [...fullPlan, ...emojiPlan];
    expect(plans[0].destinationTitle).toBe(`${'A'.repeat(BOOK_TITLE_MAX - 2)}-1`);
    expect(plans[1].destinationTitle).toBe(`${'A'.repeat(BOOK_TITLE_MAX - 3)}-1`);
    expect(plans.every((plan) => plan.destinationTitle.length <= BOOK_TITLE_MAX)).toBe(true);
    expect(plans[1].destinationTitle).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
