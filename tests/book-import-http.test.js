import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBookImportUpload } from '../src/middleware/book-import-multipart.js';
import { isBookMultipartRequest } from '../src/middleware/book-upload-lifetime.js';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { BOOK_TRANSFER_LIMITS } from '../src/services/book-transfer-limits.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';
import { makeZip } from './helpers/zip-fixture.js';

vi.mock('../src/middleware/book-import-multipart.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, parseBookImportUpload: vi.fn(actual.parseBookImportUpload) };
});

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function insertProject(db, title, slug) {
  return Number(db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
    VALUES (?, ?, '', '', 'tbd', 'images', NULL)
  `).run(title, slug).lastInsertRowid);
}

function insertAsset(db, projectId, relativePath, filename, mimeType = 'image/png') {
  return Number(db.prepare(`
    INSERT INTO assets (
      project_id, relative_path, filename, extension, mime_type, size_bytes,
      modified_at, is_present, last_seen_at
    ) VALUES (?, ?, ?, 'png', ?, 10, '2026-09-18 10:00:00', 1, datetime('now'))
  `).run(projectId, relativePath, filename, mimeType).lastInsertRowid);
}

describe('Book import HTTP contract', () => {
  let root;
  let contexts;
  let destination;

  function createContext(name, opts = {}) {
    const dir = path.join(root, name);
    const projectsRoot = path.join(dir, 'projects');
    const previewRoot = path.join(dir, 'previews');
    const exportRoot = path.join(dir, 'exports');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });
    fs.mkdirSync(exportRoot, { recursive: true });
    const db = openDatabase(path.join(dir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { appDataRoot: dir, authConfig: AUTH_CONFIG, bookExportTempRoot: exportRoot, ...opts },
    );
    const context = { dir, db, app };
    contexts.push(context);
    return context;
  }

  async function exportArchive(configure, opts = {}) {
    const source = createContext(`source-${contexts.length}`, opts);
    const bookIds = await configure(source);
    const exported = await source.app.locals.bookExportService.createExport(bookIds);
    try {
      return fs.readFileSync(exported.filePath);
    } finally {
      exported.cleanup();
    }
  }

  async function postArchive(bytes, expectedStatus = 200) {
    const { agent, csrfToken } = await authenticate(destination.app);
    return agent.post('/notes/books/import')
      .field('_csrf', csrfToken)
      .attach('archive', bytes, { filename: 'untrusted.anything', contentType: 'text/plain' })
      .set('Accept', 'application/json')
      .expect(expectedStatus);
  }

  beforeEach(() => {
    vi.mocked(parseBookImportUpload).mockClear();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-import-http-'));
    contexts = [];
    destination = createContext('destination');
  });

  afterEach(() => {
    for (const context of contexts.reverse()) {
      if (context.db.open) closeDatabase(context.db);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['/notes/books/import', '/NOTES/BOOKS/IMPORT/'])(
    'recognizes multipart import path %s using the Book upload matcher', (route) => {
      const req = { method: 'POST', path: route, headers: { 'content-type': 'multipart/form-data; boundary=test' } };
      expect(isBookMultipartRequest(req)).toBe(true);
      expect(isBookMultipartRequest({ ...req, method: 'GET' })).toBe(false);
      expect(isBookMultipartRequest({ ...req, headers: { 'content-type': 'application/json' } })).toBe(false);
    },
  );

  it('runs import parsing and routing for the case-insensitive trailing-slash path', async () => {
    const { agent, csrfToken } = await authenticate(destination.app);
    const response = await agent.post('/NOTES/BOOKS/IMPORT/').field('_csrf', csrfToken)
      .attach('archive', Buffer.from('archive'), 'books.zip')
      .set('Accept', 'application/json').expect(422);
    expect(response.body).toMatchObject({ success: false, code: 'INVALID_ARCHIVE' });
    expect(parseBookImportUpload).toHaveBeenCalledTimes(1);
    expect(destination.app.locals.managedUploadTracker.activeCount).toBe(0);
  });

  it('holds ownership while the authenticated import parser is pending', async () => {
    const { agent, csrfToken } = await authenticate(destination.app);
    const entered = deferred();
    const gate = deferred();
    const originalParser = vi.mocked(parseBookImportUpload).getMockImplementation();
    vi.mocked(parseBookImportUpload).mockImplementationOnce(async (req, res, next) => {
      entered.resolve(req);
      await gate.promise;
      return originalParser(req, res, next);
    });
    const result = agent.post('/notes/books/import').field('_csrf', csrfToken)
      .attach('archive', Buffer.from('archive'), 'books.zip')
      .set('Accept', 'application/json').then((res) => res);
    try {
      const req = await entered.promise;
      expect(req.bookUploadLifetime).toBeDefined();
      expect(destination.app.locals.managedUploadTracker.activeCount).toBe(1);
      expect(destination.app.locals.managedUploadTracker.tryBeginMaintenance()).toBeNull();
    } finally {
      gate.resolve();
      expect((await result).status).toBe(422);
    }
    expect(destination.app.locals.managedUploadTracker.activeCount).toBe(0);
  });

  it('holds ownership through asynchronous import work after disconnect and releases on success', async () => {
    const archive = await exportArchive(({ app }) => [app.locals.bookService.createBook({ title: 'Owned import' }).id]);
    const entered = deferred();
    const gate = deferred();
    closeDatabase(destination.db);
    contexts.splice(contexts.indexOf(destination), 1);
    destination = createContext('owned-destination', {
      bookImportOrchestrationService: {
        async importValidatedPlan() {
          entered.resolve();
          await gate.promise;
          return {
            importedBookCount: 0, destinationBookIds: [], books: [], associations: {},
            activity: { recorded: true },
          };
        },
      },
    });
    const originalParser = vi.mocked(parseBookImportUpload).getMockImplementation();
    let requestInParser;
    vi.mocked(parseBookImportUpload).mockImplementationOnce((req, res, next) => {
      requestInParser = req;
      return originalParser(req, res, next);
    });
    const { agent, csrfToken } = await authenticate(destination.app);
    const result = agent.post('/notes/books/import').field('_csrf', csrfToken)
      .attach('archive', archive, 'books.zip').set('Accept', 'application/json').then((res) => res);
    try {
      await entered.promise;
      const tracker = destination.app.locals.managedUploadTracker;
      expect(tracker.activeCount).toBe(1);
      expect(tracker.tryBeginMaintenance()).toBeNull();
      requestInParser.emit('aborted');
      expect(requestInParser.bookUploadLifetime.operation.signal.aborted).toBe(true);
      expect(tracker.activeCount).toBe(1);
    } finally {
      gate.resolve();
      expect((await result).status).toBe(200);
    }
    expect(destination.app.locals.managedUploadTracker.activeCount).toBe(0);
  });

  it('rejects unauthenticated imports before entering multipart parsing', async () => {
    const archive = await exportArchive(({ app }) => {
      const book = app.locals.bookService.createBook({ title: 'Authentication boundary' });
      return [book.id];
    });

    const attempts = [
      request(destination.app).post('/notes/books/import')
        .attach('archive', Buffer.alloc(0), 'empty.zip'),
      request(destination.app).post('/notes/books/import')
        .attach('wrong-field', archive, 'books.zip'),
      request(destination.app).post('/notes/books/import')
        .attach('archive', archive, 'books.zip'),
    ];

    for (const attempt of attempts) {
      const response = await attempt.set('Accept', 'application/json').expect(401);
      expect(response.body).toEqual({ status: 'error', message: 'Authentication required.' });
    }
    expect(parseBookImportUpload).not.toHaveBeenCalled();
    expect(destination.app.locals.managedUploadTracker.activeCount).toBe(0);
  });

  it('requires authentication and CSRF, then imports a real WP6 archive through WP7 and WP8', async () => {
    const archive = await exportArchive(({ app }) => {
      const book = app.locals.bookService.createBook({ title: 'Imported Book' });
      app.locals.noteService.createNote({
        bookId: book.id, title: 'Imported Page', content: '# Imported body', projectIds: [], assetIds: [],
      });
      return [book.id];
    });

    await request(destination.app).post('/notes/books/import')
      .attach('archive', archive, 'books.zip')
      .set('Accept', 'application/json')
      .expect(401);

    const authenticated = await authenticate(destination.app);
    await authenticated.agent.post('/notes/books/import')
      .attach('archive', archive, 'books.zip')
      .set('Accept', 'application/json')
      .expect(403);
    await authenticated.agent.post('/notes/books/import')
      .field('_csrf', 'not-a-valid-token')
      .attach('archive', archive, 'books.zip')
      .set('Accept', 'application/json')
      .expect(403);
    expect(destination.app.locals.managedUploadTracker.activeCount).toBe(0);

    const response = await postArchive(archive);
    expect(response.body).toMatchObject({
      success: true,
      importedBookCount: 1,
      refreshUrl: '/notes',
      activity: { recorded: true },
      books: [{
        sourceTitle: 'Imported Book', destinationTitle: 'Imported Book', renamed: false,
        coverOutcome: { kind: 'none' },
      }],
    });
    expect(response.body.destinationBookIds).toEqual([response.body.books[0].destinationBookId]);
    expect(response.body.books[0]).not.toHaveProperty('sourceBookKey');
    expect(destination.db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Imported Book']);
    expect(destination.db.prepare('SELECT title, content FROM notes').all())
      .toEqual([{ title: 'Imported Page', content: '# Imported body' }]);
  });

  it('reports collision renaming exactly as persisted', async () => {
    destination.app.locals.bookService.createBook({ title: 'Book' });
    const archive = await exportArchive(({ app }) => {
      const book = app.locals.bookService.createBook({ title: 'Book' });
      return [book.id];
    });

    const response = await postArchive(archive);
    expect(response.body.books).toEqual([expect.objectContaining({
      sourceTitle: 'Book', destinationTitle: 'Book-1', renamed: true,
    })]);
    expect(destination.db.prepare('SELECT title FROM books ORDER BY sort_order').pluck().all())
      .toEqual(['Book', 'Book-1']);
  });

  it('succeeds while preserving unresolved association locators and historical counts', async () => {
    const archive = await exportArchive(({ app, db }) => {
      const book = app.locals.bookService.createBook({ title: 'Portable associations' });
      const projectId = insertProject(db, 'Missing Destination Project', 'missing-destination-project');
      const assetId = insertAsset(db, projectId, 'art/missing.png', 'missing.png');
      app.locals.noteService.createNote({
        bookId: book.id, title: 'Associated Page', content: '', projectIds: [projectId], assetIds: [assetId],
      });
      return [book.id];
    });

    const response = await postArchive(archive);
    expect(response.body.success).toBe(true);
    expect(response.body.associations.unresolvedProjectLocators).toEqual([
      expect.objectContaining({ locator: expect.objectContaining({ slug: 'missing-destination-project' }) }),
    ]);
    expect(response.body.associations.unresolvedAssetLocators).toEqual([
      expect.objectContaining({ locator: expect.objectContaining({ relativePath: 'art/missing.png' }) }),
    ]);
    expect(response.body.associations).toMatchObject({
      historicalUnresolvedProjectCount: 0,
      historicalUnresolvedAssetCount: 0,
    });
    expect(destination.db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Portable associations']);
  });

  it('imports an animated Project-cover fallback under managed authority', async () => {
    const animated = await makeAnimatedWebp(3);
    const mediaService = {
      async prepareDerivativeResponse() {
        return { stream: Readable.from(animated), cleanup() {} };
      },
    };
    const archive = await exportArchive(({ app, db }) => {
      const book = app.locals.bookService.createBook({ title: 'Animated fallback' });
      const projectId = insertProject(db, 'Absent Cover Project', 'absent-cover-project');
      const assetId = insertAsset(db, projectId, 'covers/animated.png', 'animated.png');
      app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
      return [book.id];
    }, { mediaService });

    const response = await postArchive(archive);
    expect(response.body.books[0].coverOutcome).toMatchObject({
      kind: 'managed', sourceKind: 'project_asset', relinked: false,
      unresolvedReason: 'project_not_found',
    });
    expect(destination.db.prepare('SELECT managed_asset_id FROM book_primary_images').get().managed_asset_id)
      .toBeTruthy();
    const managed = destination.db.prepare('SELECT storage_key FROM managed_assets').get();
    const storedBytes = fs.readFileSync(path.join(destination.dir, 'assets', managed.storage_key));
    const metadata = await sharp(storedBytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(3);
  });

  it('returns controlled validation errors without changing existing destination state', async () => {
    destination.app.locals.bookService.createBook({ title: 'Existing destination' });
    const before = {
      books: destination.db.prepare('SELECT * FROM books').all(),
      managed: destination.db.prepare('SELECT * FROM managed_assets').all(),
      activity: destination.db.prepare("SELECT * FROM application_logs WHERE event = 'book.imported'").all(),
    };

    const malformed = await postArchive(Buffer.from('not a zip'), 422);
    expect(malformed.body).toEqual({
      success: false, code: 'INVALID_ARCHIVE', message: 'The supplied file is not a valid ZIP archive.',
    });
    expect(destination.db.prepare('SELECT * FROM books').all()).toEqual(before.books);
    expect(destination.db.prepare('SELECT * FROM managed_assets').all()).toEqual(before.managed);
    expect(destination.db.prepare("SELECT * FROM application_logs WHERE event = 'book.imported'").all()).toEqual(before.activity);
  });

  it('keeps a committed import successful when aggregate activity recording is unavailable', async () => {
    closeDatabase(destination.db);
    contexts.splice(contexts.indexOf(destination), 1);
    const warningService = { async importValidatedPlan() {} };
    destination = createContext('warning-destination', { bookImportOrchestrationService: warningService });
    warningService.importValidatedPlan = async () => {
      const book = destination.app.locals.bookService.createBook({ title: 'Activity warning' });
      const associations = {
        resolvedProjectAssociationCount: 0,
        resolvedAssetAssociationCount: 0,
        unresolvedProjectLocators: [],
        unresolvedAssetLocators: [],
        historicalUnresolvedProjectCount: 0,
        historicalUnresolvedAssetCount: 0,
      };
      return {
        success: true,
        importedBookCount: 1,
        destinationBookIds: [book.id],
        books: [{
          sourceBookKey: 'book-1', sourceTitle: 'Activity warning', destinationBookId: book.id,
          destinationTitle: book.title, renamed: false, coverOutcome: { kind: 'none' }, associations,
        }],
        associations,
        activity: { recorded: false, warning: 'activity_not_recorded' },
      };
    };
    const archive = await exportArchive(({ app }) => {
      const book = app.locals.bookService.createBook({ title: 'Activity warning' });
      return [book.id];
    });
    const { agent, csrfToken } = await authenticate(destination.app);

    const response = await agent.post('/notes/books/import')
      .field('_csrf', csrfToken).attach('archive', archive, 'books.zip')
      .set('Accept', 'application/json').expect(200);
    expect(response.body).toMatchObject({
      success: true,
      importedBookCount: 1,
      activity: { recorded: false, warning: 'activity_not_recorded' },
    });
    expect(destination.db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Activity warning']);
  });

  it('maps missing, empty, unexpected, multiple, unsupported-version, and oversized uploads consistently', async () => {
    const { agent, csrfToken } = await authenticate(destination.app);
    const missing = await agent.post('/notes/books/import').field('_csrf', csrfToken)
      .set('Accept', 'application/json').expect(400);
    expect(missing.body).toMatchObject({ success: false, code: 'MISSING_FILE' });

    const empty = await agent.post('/notes/books/import').field('_csrf', csrfToken)
      .attach('archive', Buffer.alloc(0), 'empty.zip').set('Accept', 'application/json').expect(400);
    expect(empty.body).toMatchObject({ success: false, code: 'EMPTY_FILE' });

    const unexpected = await agent.post('/notes/books/import').field('_csrf', csrfToken)
      .attach('wrong-field', Buffer.from('archive'), 'books.zip')
      .set('Accept', 'application/json').expect(400);
    expect(unexpected.body).toMatchObject({ success: false, code: 'UNEXPECTED_FILE' });

    const multiple = await agent.post('/notes/books/import').field('_csrf', csrfToken)
      .attach('archive', Buffer.from('one'), 'one.zip')
      .attach('archive', Buffer.from('two'), 'two.zip')
      .set('Accept', 'application/json').expect(400);
    expect(multiple.body).toMatchObject({ success: false, code: 'TOO_MANY_FILES' });

    const unsupportedArchive = makeZip([{ name: 'creatorcrate-books.json', data: JSON.stringify({
      format: 'creatorcrate-books', version: 2, books: [],
    }) }]);
    const unsupported = await postArchive(unsupportedArchive, 422);
    expect(unsupported.body).toMatchObject({ success: false, code: 'UNSUPPORTED_VERSION' });
    expect(destination.app.locals.managedUploadTracker.activeCount).toBe(0);

    const oversized = await postArchive(Buffer.alloc(BOOK_TRANSFER_LIMITS.compressedArchiveBytes + 1), 413);
    expect(oversized.body).toMatchObject({ success: false, code: 'ARCHIVE_LIMIT_EXCEEDED' });
  }, 30_000);

  it('keeps operational failures out of the validation taxonomy and exposes no internals', async () => {
    closeDatabase(destination.db);
    contexts.splice(contexts.indexOf(destination), 1);
    destination = createContext('runtime-destination', {
      bookImportOrchestrationService: {
        async importValidatedPlan() { throw new Error('SQLITE path C:\\secret libvips failure'); },
      },
    });
    const archive = await exportArchive(({ app }) => {
      const book = app.locals.bookService.createBook({ title: 'Runtime failure' });
      return [book.id];
    });

    const response = await postArchive(archive, 500);
    expect(response.body).toEqual({ status: 'error', message: 'Internal server error.' });
    expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|secret|libvips|stack/i);
    expect(destination.db.prepare('SELECT * FROM books').all()).toEqual([]);
    expect(destination.db.prepare('SELECT * FROM managed_assets').all()).toEqual([]);
  });
});
