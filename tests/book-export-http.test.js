import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createBookExportService } from '../src/services/book-export-service.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { parseBookImportArchive } from '../src/services/book-import-service.js';
import { BOOK_TRANSFER_LIMITS } from '../src/services/book-transfer-limits.js';
import {
  MediaNotFoundError,
  MediaUnavailableError,
  MediaUnsupportedError,
} from '../src/services/media-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { AUTH_CONFIG, getDisabledModeCsrf, requestLoginPage } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function readZipEntries(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = new Map();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
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
    ) VALUES (?, ?, ?, 'png', 'image/png', 10, '2026-09-18 10:00:00', 1, datetime('now'))
  `).run(projectId, relativePath, filename).lastInsertRowid);
}

function createCountedStream(chunks) {
  let consumedChunks = 0;
  const stream = {
    destroyed: false,
    destroy() { this.destroyed = true; },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (this.destroyed) return;
        consumedChunks += 1;
        yield chunk;
      }
    },
  };
  return { stream, consumedChunks: () => consumedChunks };
}

describe('Book export HTTP contract', () => {
  let db;
  let app;
  let agent;
  let csrfToken;
  let tmpDir;
  let appDataRoot;
  let exportTempRoot;
  let mediaBytes;
  let mediaService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-export-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    appDataRoot = path.join(tmpDir, 'app');
    const previewRoot = path.join(tmpDir, 'previews');
    exportTempRoot = path.join(tmpDir, 'exports');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });
    fs.mkdirSync(exportTempRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    mediaBytes = await sharp({
      create: { width: 12, height: 8, channels: 4, background: '#336699' },
    }).webp().toBuffer();
    mediaService = {
      prepareDerivativeResponse: vi.fn(async () => ({
        stream: Readable.from(mediaBytes),
        cleanup: vi.fn(),
      })),
    };
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { appDataRoot, authState: { csrfPepper }, mediaService, bookExportTempRoot: exportTempRoot },
    );
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function exportBooks(bookIds) {
    const response = await agent.post('/notes/books/export')
      .type('form')
      .send({ _csrf: csrfToken, bookIds })
      .buffer(true)
      .parse(binaryParser)
      .expect(200)
      .expect('Content-Type', /zip/)
      .expect('Content-Disposition', /attachment; filename="creatorcrate-books.zip"/);
    return readZipEntries(response.body);
  }

  it('exports complete Books in shelf order with archive-local hierarchy, revisions, previews, and portable associations', async () => {
    const first = app.locals.bookService.createBook({ title: 'First shelf Book' });
    const second = app.locals.bookService.createBook({ title: 'Second shelf Book' });
    app.locals.bookService.reorderBooks([second.id, first.id]);

    const projectId = insertProject(db, 'Portable Project', 'portable-project');
    const assetId = insertAsset(db, projectId, 'covers/source.png', 'source.png');
    const chapter = app.locals.chapterService.createChapter({ bookId: second.id, title: 'Chapter A' });
    const nested = app.locals.noteService.createNote({
      bookId: second.id,
      chapterId: chapter.id,
      title: 'Nested Page',
      content: '# Original\n\n`123` and /notes/456',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const root = app.locals.noteService.createNote({
      bookId: second.id,
      title: 'Root Page',
      content: 'Root **Markdown**',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    app.locals.noteService.updateNote(nested.id, {
      title: 'Nested Page v2',
      content: '# Middle\n\nDo not rewrite 123.',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    app.locals.noteService.updateNote(nested.id, {
      title: 'Nested Page current',
      content: '# Current\n\n[link](/notes/456)',
      projectIds: [],
      assetIds: [],
    });
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(second.id, {
      mode: 'selected', randomCount: 7, selectedPageIds: [root.id, nested.id],
    });

    const entries = await exportBooks([first.id, second.id, second.id]);
    expect([...entries.keys()]).toEqual(['creatorcrate-books.json']);
    const manifest = JSON.parse(entries.get('creatorcrate-books.json').toString('utf8'));
    expect(manifest).toMatchObject({ format: 'creatorcrate-books', version: 1 });
    expect(manifest.books.map((book) => book.title)).toEqual(['Second shelf Book', 'First shelf Book']);

    const exported = manifest.books[0];
    expect(exported.key).toBe('book-1');
    expect(exported.rootContents).toEqual([
      { type: 'chapter', key: 'chapter-1' },
      { type: 'page', key: 'page-2' },
    ]);
    expect(exported.chapters).toEqual([expect.objectContaining({
      key: 'chapter-1', title: 'Chapter A', pageKeys: ['page-1'],
    })]);
    expect(exported.pages.map((page) => [page.key, page.chapterKey, page.title])).toEqual([
      ['page-1', 'chapter-1', 'Nested Page current'],
      ['page-2', null, 'Root Page'],
    ]);
    expect(exported.pages[0].rawMarkdown).toBe('# Current\n\n[link](/notes/456)');
    expect(exported.pages[0].revisions.map((revision) => revision.rawMarkdown)).toEqual([
      '# Middle\n\nDo not rewrite 123.',
      '# Original\n\n`123` and /notes/456',
    ]);
    expect(exported.pages[0].revisions[0].associations).toMatchObject({
      projects: [{ slug: 'portable-project', title: 'Portable Project', projectType: 'images' }],
      assets: [expect.objectContaining({ relativePath: 'covers/source.png', filename: 'source.png' })],
    });
    expect(exported.pages[1].associations).toMatchObject({
      projects: [{ slug: 'portable-project', title: 'Portable Project', projectType: 'images' }],
      assets: [expect.objectContaining({ relativePath: 'covers/source.png', filename: 'source.png' })],
    });
    expect(exported.previewSettings).toEqual({
      mode: 'selected', randomCount: 7, selectedPageKeys: ['page-1', 'page-2'],
    });
    expect(exported.cover).toEqual({ kind: 'none' });
    expect(manifest.books[1]).toMatchObject({
      key: 'book-2', title: 'First shelf Book', rootContents: [], chapters: [], pages: [],
      previewSettings: { mode: 'random', randomCount: 5, selectedPageKeys: [] },
    });

    const serialized = JSON.stringify(manifest);
    for (const forbidden of ['projectId', 'assetId', 'bookId', 'noteId', 'sort_order', 'storage_key', 'project_dir', 'navigation']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain(tmpDir);
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('packages managed and Project/Asset-backed covers without source storage authority', async () => {
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

    const entries = await exportBooks([managedBook.id, projectBook.id]);
    const manifest = JSON.parse(entries.get('creatorcrate-books.json').toString('utf8'));
    expect(entries.get('covers/book-1/cover.png')).toEqual(managedBytes);
    expect(entries.get('covers/book-2/cover.webp')).toEqual(mediaBytes);
    expect(manifest.books[0].cover).toMatchObject({
      kind: 'managed', media: { path: 'covers/book-1/cover.png', mimeType: 'image/png' },
    });
    expect(manifest.books[1].cover).toMatchObject({
      kind: 'project_asset',
      source: {
        project: { slug: 'cover-project', title: 'Cover Project', projectType: 'images' },
        relativePath: 'art/cover.png', filename: 'cover.png', extension: 'png', mimeType: 'image/png',
      },
      media: { path: 'covers/book-2/cover.webp', mimeType: 'image/webp' },
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(record.id);
    expect(serialized).not.toContain('storage_key');
    expect(serialized).not.toContain('sourceAuthority');
    expect(serialized).not.toContain('modifiedAt');
    expect(serialized).not.toContain('isPresent');
    expect(mediaService.prepareDerivativeResponse).toHaveBeenCalledWith('preview', projectId, assetId,
      undefined, { ensureCurrent: true });
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects a Project cover whose authoritative media revision changes during export', async () => {
    const book = app.locals.bookService.createBook({ title: 'Changing cover Book' });
    const projectId = insertProject(db, 'Changing Cover Project', 'changing-cover-project');
    const assetId = insertAsset(db, projectId, 'art/changing.png', 'changing.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    const cleanup = vi.fn();
    mediaService.prepareDerivativeResponse.mockImplementationOnce(async () => {
      db.prepare(`
        UPDATE assets
        SET size_bytes = ?, modified_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(25, '2026-09-18 10:00:01', assetId);
      return { stream: Readable.from(mediaBytes), cleanup };
    });

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(409);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).toEqual({
      status: 'error',
      code: 'EXPORT_CHANGED',
      message: 'The selected Books changed during export. Please try again.',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects empty, malformed, missing, CSRF-less, and unavailable Project-cover exports', async () => {
    const book = app.locals.bookService.createBook({ title: 'Failure Book' });
    await agent.post('/notes/books/export').type('form').send({ _csrf: csrfToken })
      .expect(422).expect(({ body }) => expect(body.code).toBe('EMPTY_SELECTION'));
    await agent.post('/notes/books/export').type('form').send({ _csrf: csrfToken, bookIds: '01' })
      .expect(422).expect(({ body }) => expect(body.code).toBe('MALFORMED_SELECTION'));
    await agent.post('/notes/books/export').type('form').send({ _csrf: csrfToken, bookIds: '999999' })
      .expect(404).expect(({ body }) => expect(body.code).toBe('BOOK_NOT_FOUND'));
    await agent.post('/notes/books/export').type('form').send({ bookIds: String(book.id) }).expect(403);

    const projectId = insertProject(db, 'Missing Cover Project', 'missing-cover-project');
    const assetId = insertAsset(db, projectId, 'missing.png', 'missing.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    mediaService.prepareDerivativeResponse.mockRejectedValueOnce(new MediaNotFoundError('Asset is not available.'));
    const unavailable = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(409);
    expect(unavailable.body).toEqual({
      status: 'error', code: 'COVER_UNAVAILABLE', message: 'A required Book cover is unavailable.',
    });
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('maps an unavailable managed cover to COVER_UNAVAILABLE', async () => {
    const book = app.locals.bookService.createBook({ title: 'Missing managed cover Book' });
    const managedBytes = await sharp({
      create: { width: 9, height: 6, channels: 4, background: '#ff8844' },
    }).png().toBuffer();
    const { record } = await app.locals.managedImageService.createCommittedImage({ bytes: managedBytes });
    app.locals.bookPrimaryImageService.setManagedPrimaryImage(book.id, record.id);
    fs.rmSync(path.join(appDataRoot, 'assets', record.storage_key));

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(409);
    expect(response.body).toEqual({
      status: 'error', code: 'COVER_UNAVAILABLE', message: 'A required Book cover is unavailable.',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it.each([
    ['unavailable preview', new MediaUnavailableError('Preview unavailable')],
    ['unsupported preview', new MediaUnsupportedError('Unsupported media type')],
  ])('maps a recognized Project-cover %s to COVER_UNAVAILABLE', async (_label, error) => {
    const book = app.locals.bookService.createBook({ title: 'Unavailable Project cover Book' });
    const projectId = insertProject(db, 'Unavailable Cover Project', 'unavailable-cover-project');
    const assetId = insertAsset(db, projectId, 'unavailable.png', 'unavailable.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    mediaService.prepareDerivativeResponse.mockRejectedValueOnce(error);

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(409);
    expect(response.body).toEqual({
      status: 'error', code: 'COVER_UNAVAILABLE', message: 'A required Book cover is unavailable.',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('keeps unexpected Project-cover failures as controlled export 500s', async () => {
    const book = app.locals.bookService.createBook({ title: 'Unexpected cover failure Book' });
    const projectId = insertProject(db, 'Unexpected Cover Project', 'unexpected-cover-project');
    const assetId = insertAsset(db, projectId, 'unexpected.png', 'unexpected.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    mediaService.prepareDerivativeResponse.mockRejectedValueOnce(new TypeError('secret media bug'));

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(500);
    expect(response.body).toEqual({
      status: 'error', code: 'EXPORT_ASSEMBLY_FAILED', message: 'The Book export could not be assembled.',
    });
    expect(response.text).not.toContain('secret media bug');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('keeps the export endpoint behind the application authentication boundary', async () => {
    const authDir = path.join(tmpDir, 'auth-app');
    fs.mkdirSync(authDir, { recursive: true });
    const authDb = openDatabase(path.join(authDir, 'test.db'));
    try {
      runMigrations(authDb, MIGRATIONS_DIR);
      const authApp = createApp(
        { appName: 'CreatorCrate', db: authDb },
        { authConfig: AUTH_CONFIG, appDataRoot: authDir, bookExportTempRoot: exportTempRoot },
      );
      const anonymous = await requestLoginPage(authApp);
      const response = await anonymous.agent.post('/notes/books/export').type('form')
        .send({ _csrf: anonymous.csrfToken, bookIds: '1' }).expect(401);
      expect(response.headers.location).toBeUndefined();
    } finally {
      closeDatabase(authDb);
    }
  });

  it('removes its owned temporary directory when archive creation fails', async () => {
    const book = app.locals.bookService.createBook({ title: 'Archive failure Book' });
    const service = createBookExportService({
      db,
      managedMediaService: app.locals.managedMediaService,
      mediaService,
      tempRoot: exportTempRoot,
      archiveWriter: async () => { throw new Error('simulated writer failure'); },
    });
    await expect(service.createExport([book.id])).rejects.toMatchObject({
      code: 'ARCHIVE_WRITE_FAILED', status: 500,
    });
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('fails instead of returning a different set when a selected Book disappears during cover resolution', async () => {
    const book = app.locals.bookService.createBook({ title: 'Disappearing Book' });
    const projectId = insertProject(db, 'Transient Cover Project', 'transient-cover-project');
    const assetId = insertAsset(db, projectId, 'transient.png', 'transient.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    mediaService.prepareDerivativeResponse.mockImplementationOnce(async () => {
      db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
      return { stream: Readable.from(mediaBytes), cleanup: vi.fn() };
    });

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(409);
    expect(response.body).toEqual({
      status: 'error', code: 'EXPORT_CHANGED',
      message: 'The selected Books changed during export. Please try again.',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/json/);
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('keeps an unexpected verification database failure as a controlled export 500', async () => {
    const book = app.locals.bookService.createBook({ title: 'Verification failure Book' });
    const projectId = insertProject(db, 'Verification Cover Project', 'verification-cover-project');
    const assetId = insertAsset(db, projectId, 'verification.png', 'verification.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    const cleanup = vi.fn();
    mediaService.prepareDerivativeResponse.mockImplementationOnce(async () => {
      const activeDb = db;
      db = null;
      activeDb.close();
      return { stream: Readable.from(mediaBytes), cleanup };
    });

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(book.id) }).expect(500);
    expect(response.body).toEqual({
      status: 'error', code: 'EXPORT_ASSEMBLY_FAILED', message: 'The Book export could not be assembled.',
    });
    expect(response.text).not.toContain('database connection is not open');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('fails the whole deduplicated multi-Book export when one selected Book disappears', async () => {
    const stableBook = app.locals.bookService.createBook({ title: 'Stable Book' });
    const disappearingBook = app.locals.bookService.createBook({ title: 'Disappearing Book' });
    const projectId = insertProject(db, 'Transient Cover Project', 'transient-cover-project');
    const assetId = insertAsset(db, projectId, 'transient.png', 'transient.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(disappearingBook.id, assetId);
    mediaService.prepareDerivativeResponse.mockImplementationOnce(async () => {
      db.prepare('DELETE FROM books WHERE id = ?').run(disappearingBook.id);
      return { stream: Readable.from(mediaBytes), cleanup: vi.fn() };
    });

    const response = await agent.post('/notes/books/export').type('form')
      .send({
        _csrf: csrfToken,
        bookIds: [String(stableBook.id), String(disappearingBook.id), String(disappearingBook.id)],
      })
      .expect(409);
    expect(response.body).toEqual({
      status: 'error', code: 'EXPORT_CHANGED',
      message: 'The selected Books changed during export. Please try again.',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/json/);
    expect(mediaService.prepareDerivativeResponse).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('exports the maximum supported Book count and produces a WP7-parsable archive', async () => {
    const ids = Array.from({ length: BOOK_TRANSFER_LIMITS.maximumBooks }, (_, index) => (
      app.locals.bookService.createBook({ title: `Boundary Book ${index + 1}` }).id
    ));
    const exported = await app.locals.bookExportService.createExport(ids);
    try {
      const parsed = await parseBookImportArchive(fs.readFileSync(exported.filePath));
      expect(parsed.books).toHaveLength(BOOK_TRANSFER_LIMITS.maximumBooks);
    } finally {
      exported.cleanup();
    }
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects the reviewer 257-Book selection before cover or archive work', async () => {
    const ids = Array.from({ length: BOOK_TRANSFER_LIMITS.maximumBooks + 1 }, (_, index) => (
      app.locals.bookService.createBook({ title: `Rejected Book ${index + 1}` }).id
    ));
    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: ids.map(String) }).expect(422);
    expect(response.body).toEqual({
      status: 'error',
      code: 'EXPORT_LIMIT_EXCEEDED',
      message: 'The selected Books exceed the supported transfer limits.',
    });
    expect(mediaService.prepareDerivativeResponse).not.toHaveBeenCalled();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('exports and re-parses the reviewer manifest above 4 MiB', async () => {
    const source = app.locals.bookService.createBook({ title: 'Large manifest Book' });
    for (let index = 0; index < 42; index += 1) {
      app.locals.noteService.createNote({
        bookId: source.id,
        title: `Large Page ${index + 1}`,
        content: 'x'.repeat(102_400),
      });
    }
    const exported = await app.locals.bookExportService.createExport([source.id]);
    try {
      const entries = await readZipEntries(fs.readFileSync(exported.filePath));
      const manifestBytes = entries.get('creatorcrate-books.json');
      expect(manifestBytes.length).toBeGreaterThan(4 * 1024 * 1024);
      expect(manifestBytes.length).toBeLessThanOrEqual(BOOK_TRANSFER_LIMITS.manifestBytes);
      await expect(parseBookImportArchive(fs.readFileSync(exported.filePath)))
        .resolves.toMatchObject({ books: [{ pages: expect.any(Array) }] });
    } finally {
      exported.cleanup();
    }
  });

  it('rejects an actual serialized manifest over the shared UTF-8 byte limit', async () => {
    const source = app.locals.bookService.createBook({ title: 'Oversized manifest Book' });
    const note = app.locals.noteService.createNote({ bookId: source.id, title: 'Large Page', content: '' });
    db.prepare('UPDATE notes SET content = ? WHERE id = ?')
      .run('😀'.repeat(Math.ceil(BOOK_TRANSFER_LIMITS.manifestBytes / 2)), note.id);

    await expect(app.locals.bookExportService.createExport([source.id])).rejects.toMatchObject({
      code: 'EXPORT_LIMIT_EXCEEDED', status: 422,
    });
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('stops an oversized Project-cover response while streaming', async () => {
    const source = app.locals.bookService.createBook({ title: 'Oversized cover Book' });
    const projectId = insertProject(db, 'Oversized Cover Project', 'oversized-cover-project');
    const assetId = insertAsset(db, projectId, 'oversized.png', 'oversized.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
    const counted = createCountedStream(Array.from(
      { length: 12 },
      () => Buffer.alloc(1024 * 1024),
    ));
    const cleanup = vi.fn(() => {
      if (!counted.stream.destroyed) counted.stream.destroy();
    });
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({
      stream: counted.stream,
      cleanup,
    });

    const response = await agent.post('/notes/books/export').type('form')
      .send({ _csrf: csrfToken, bookIds: String(source.id) }).expect(422);
    expect(response.body).toMatchObject({
      status: 'error', code: 'EXPORT_LIMIT_EXCEEDED',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(counted.consumedChunks()).toBe(11);
    expect(counted.stream.destroyed).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects a one-byte overflow without consuming the remaining Project-cover body', async () => {
    const source = app.locals.bookService.createBook({ title: 'One-byte overflow Book' });
    const projectId = insertProject(db, 'One-byte Overflow Project', 'one-byte-overflow-project');
    const assetId = insertAsset(db, projectId, 'one-byte-overflow.png', 'one-byte-overflow.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
    const counted = createCountedStream([
      Buffer.alloc(BOOK_TRANSFER_LIMITS.coverBytes),
      Buffer.alloc(1),
      Buffer.alloc(1024 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    const cleanup = vi.fn(() => {
      if (!counted.stream.destroyed) counted.stream.destroy();
    });
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({ stream: counted.stream, cleanup });

    await expect(app.locals.bookExportService.createExport([source.id])).rejects.toMatchObject({
      code: 'EXPORT_LIMIT_EXCEEDED', status: 422,
    });
    expect(counted.consumedChunks()).toBe(2);
    expect(counted.stream.destroyed).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects an oversized declared Project-cover length before consuming its body', async () => {
    const source = app.locals.bookService.createBook({ title: 'Declared oversized cover Book' });
    const projectId = insertProject(db, 'Declared Oversized Project', 'declared-oversized-project');
    const assetId = insertAsset(db, projectId, 'declared-oversized.png', 'declared-oversized.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
    const counted = createCountedStream([Buffer.alloc(1)]);
    const cleanup = vi.fn(() => {
      if (!counted.stream.destroyed) counted.stream.destroy();
    });
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({
      headers: { 'Content-Length': String(BOOK_TRANSFER_LIMITS.coverBytes + 1) },
      stream: counted.stream,
      cleanup,
    });

    await expect(app.locals.bookExportService.createExport([source.id])).rejects.toMatchObject({
      code: 'EXPORT_LIMIT_EXCEEDED', status: 422,
    });
    expect(counted.consumedChunks()).toBe(0);
    expect(counted.stream.destroyed).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('bounds a generated PNG cover before conversion', async () => {
    const book = app.locals.bookService.createBook({ title: 'Oversized PNG preview' });
    const projectId = insertProject(db, 'PNG Preview Project', 'png-preview-project');
    const assetId = insertAsset(db, projectId, 'preview.png', 'preview.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    const counted = createCountedStream([Buffer.alloc(1)]);
    const cleanup = vi.fn(() => counted.stream.destroy());
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(BOOK_TRANSFER_LIMITS.totalUncompressedBytes + 1),
      },
      stream: counted.stream, cleanup,
    });

    await expect(app.locals.bookExportService.createExport([book.id])).rejects.toMatchObject({
      code: 'EXPORT_LIMIT_EXCEEDED', status: 422,
    });
    expect(counted.consumedChunks()).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('rejects invalid generated PNG bytes through export error handling', async () => {
    const book = app.locals.bookService.createBook({ title: 'Invalid PNG preview' });
    const projectId = insertProject(db, 'Invalid PNG Project', 'invalid-png-project');
    const assetId = insertAsset(db, projectId, 'preview.png', 'preview.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    const cleanup = vi.fn();
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({
      headers: { 'Content-Type': 'image/png' },
      stream: Readable.from(Buffer.from('not a PNG')), cleanup,
    });

    await expect(app.locals.bookExportService.createExport([book.id])).rejects.toMatchObject({
      code: 'EXPORT_ASSEMBLY_FAILED', status: 500,
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('cleans up a Project-cover response when its source stream fails', async () => {
    const source = app.locals.bookService.createBook({ title: 'Failing stream cover Book' });
    const projectId = insertProject(db, 'Failing Stream Project', 'failing-stream-project');
    const assetId = insertAsset(db, projectId, 'failing-stream.png', 'failing-stream.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
    const stream = Readable.from((async function* failingSource() {
      yield Buffer.alloc(1);
      throw new Error('simulated source failure');
    }()));
    const cleanup = vi.fn(() => {
      if (!stream.destroyed) stream.destroy();
    });
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({ stream, cleanup });

    await expect(app.locals.bookExportService.createExport([source.id])).rejects.toMatchObject({
      code: 'EXPORT_ASSEMBLY_FAILED', status: 500,
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('cleans up a Project-cover response when chunk conversion fails', async () => {
    const source = app.locals.bookService.createBook({ title: 'Invalid chunk cover Book' });
    const projectId = insertProject(db, 'Invalid Chunk Project', 'invalid-chunk-project');
    const assetId = insertAsset(db, projectId, 'invalid-chunk.png', 'invalid-chunk.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
    const stream = createCountedStream([Symbol('invalid binary chunk')]).stream;
    const cleanup = vi.fn(() => stream.destroy());
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({ stream, cleanup });

    await expect(app.locals.bookExportService.createExport([source.id])).rejects.toMatchObject({
      code: 'EXPORT_ASSEMBLY_FAILED', status: 500,
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('exports and re-parses a valid cover at the authoritative byte limit', async () => {
    const source = app.locals.bookService.createBook({ title: 'Boundary cover Book' });
    const projectId = insertProject(db, 'Boundary Cover Project', 'boundary-cover-project');
    const assetId = insertAsset(db, projectId, 'boundary.png', 'boundary.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
    const base = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ffffff' },
    }).webp().toBuffer();
    const paddingLength = BOOK_TRANSFER_LIMITS.coverBytes - base.length - 8;
    const paddingChunk = Buffer.alloc(8 + paddingLength + (paddingLength % 2));
    paddingChunk.write('paDd', 0, 'ascii');
    paddingChunk.writeUInt32LE(paddingLength, 4);
    const boundaryBytes = Buffer.concat([base, paddingChunk]);
    boundaryBytes.writeUInt32LE(boundaryBytes.length - 8, 4);
    const cleanup = vi.fn();
    mediaService.prepareDerivativeResponse.mockResolvedValueOnce({
      headers: { 'Content-Length': String(boundaryBytes.length) },
      stream: Readable.from(boundaryBytes), cleanup,
    });

    const exported = await app.locals.bookExportService.createExport([source.id]);
    try {
      const parsed = await parseBookImportArchive(fs.readFileSync(exported.filePath));
      expect(parsed.books[0].cover.media.bytes).toHaveLength(BOOK_TRANSFER_LIMITS.coverBytes);
    } finally {
      exported.cleanup();
    }
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects actual cover payloads whose aggregate exceeds the shared uncompressed limit', async () => {
    const projectId = insertProject(db, 'Aggregate Cover Project', 'aggregate-cover-project');
    const assetId = insertAsset(db, projectId, 'aggregate.png', 'aggregate.png');
    const ids = Array.from({ length: 7 }, (_, index) => {
      const source = app.locals.bookService.createBook({ title: `Aggregate Cover Book ${index + 1}` });
      app.locals.bookPrimaryImageService.setPrimaryImage(source.id, assetId);
      return source.id;
    });
    const fullCover = Buffer.alloc(BOOK_TRANSFER_LIMITS.coverBytes);
    const remainingBytes = BOOK_TRANSFER_LIMITS.totalUncompressedBytes
      - (6 * BOOK_TRANSFER_LIMITS.coverBytes);
    const finalCounted = createCountedStream([
      ...Array.from({ length: remainingBytes / (1024 * 1024) }, () => Buffer.alloc(1024 * 1024)),
      Buffer.alloc(1),
      Buffer.alloc(1024 * 1024),
    ]);
    const finalCleanup = vi.fn(() => {
      if (!finalCounted.stream.destroyed) finalCounted.stream.destroy();
    });
    mediaService.prepareDerivativeResponse.mockImplementation(async () => (
      mediaService.prepareDerivativeResponse.mock.calls.length <= 6
        ? { stream: Readable.from(fullCover), cleanup: vi.fn() }
        : { stream: finalCounted.stream, cleanup: finalCleanup }
    ));

    await expect(app.locals.bookExportService.createExport(ids)).rejects.toMatchObject({
      code: 'EXPORT_LIMIT_EXCEEDED', status: 422,
    });
    expect(mediaService.prepareDerivativeResponse).toHaveBeenCalledTimes(7);
    expect(finalCounted.consumedChunks()).toBe((remainingBytes / (1024 * 1024)) + 1);
    expect(finalCounted.stream.destroyed).toBe(true);
    expect(finalCleanup).toHaveBeenCalledOnce();
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });

  it('removes an archive that exceeds the final compressed-byte limit', async () => {
    const source = app.locals.bookService.createBook({ title: 'Compressed limit Book' });
    const service = createBookExportService({
      db,
      managedMediaService: app.locals.managedMediaService,
      mediaService,
      tempRoot: exportTempRoot,
      archiveWriter: async (filePath) => {
        fs.writeFileSync(filePath, Buffer.alloc(0), { flag: 'wx' });
        fs.truncateSync(filePath, BOOK_TRANSFER_LIMITS.compressedArchiveBytes + 1);
      },
    });
    await expect(service.createExport([source.id])).rejects.toMatchObject({
      code: 'EXPORT_LIMIT_EXCEEDED', status: 422,
    });
    expect(fs.readdirSync(exportTempRoot)).toEqual([]);
  });
});

describe('Book export Project-cover processing admission', () => {
  let db;
  let tmpDir;

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('admits generated Project-cover preview work once through the shared pool, then reads it cached', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-export-pool-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    const previewRoot = path.join(tmpDir, 'previews');
    for (const dir of [projectsRoot, appDataRoot, previewRoot]) fs.mkdirSync(dir, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);

    // Capacity one: a nested acquisition anywhere on this path would deadlock.
    const pool = createProcessingConcurrencyService({ concurrency: 1 });
    let admitted = 0;
    const processingConcurrencyService = Object.freeze({
      concurrency: 1,
      mapBounded: pool.mapBounded,
      run: (task) => pool.run(() => { admitted += 1; return task(); }),
    });
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { appDataRoot, authState: { csrfPepper }, processingConcurrencyService,
        bookExportTempRoot: path.join(tmpDir, 'exports') },
    );
    fs.mkdirSync(path.join(tmpDir, 'exports'));

    const projectId = insertProject(db, 'Pool Cover Project', 'pool-cover-project');
    db.prepare("UPDATE projects SET project_dir = 'pool-cover' WHERE id = ?").run(projectId);
    const coverPath = path.join(projectsRoot, 'pool-cover', 'art', 'cover.png');
    fs.mkdirSync(path.dirname(coverPath), { recursive: true });
    fs.writeFileSync(coverPath, await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#224466' },
    }).png().toBuffer());
    const stat = fs.statSync(coverPath);
    const assetId = insertAsset(db, projectId, 'art/cover.png', 'cover.png');
    db.prepare('UPDATE assets SET size_bytes = ?, modified_at = ? WHERE id = ?')
      .run(stat.size, stat.mtime.toISOString(), assetId);
    const book = app.locals.bookService.createBook({ title: 'Pool cover Book' });
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);

    const first = await app.locals.bookExportService.createExport([book.id]);
    try {
      const entries = await readZipEntries(fs.readFileSync(first.filePath));
      expect((await sharp(entries.get('covers/book-1/cover.webp')).metadata()).format).toBe('webp');
    } finally {
      first.cleanup();
    }
    expect(admitted).toBe(1);

    const second = await app.locals.bookExportService.createExport([book.id]);
    second.cleanup();
    expect(admitted).toBe(1);
  });
});
