import { admittedUpload } from './helpers/book-upload-lifetime.js';
import { expectBookCoverForm } from './helpers/book-cover-form.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';
import { BookValidationError } from '../src/services/book-service.js';
import { updateBookWithUploadedCover as updateBookWithUploadedCoverHandler } from '../src/middleware/book-edit-multipart.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('WP7D2B Edit Book multipart HTTP', () => {
  let tmp, db, app, agent, csrfToken, bytes, book;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp7d2b-'));
    db = openDatabase(':memory:');
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
    app = createApp({ appName: 'CreatorCrate', db, previewRoot: path.join(tmp, 'previews') }, {
      appDataRoot: tmp, authConfig: AUTH_CONFIG,
    });
    ({ agent, csrfToken } = await authenticate(app));
    book = app.locals.bookService.createBook({ title: 'Original' });
    bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  });
  afterEach(() => {
    expect(app.locals.managedUploadTracker.hasActive()).toBe(false);
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const post = () => agent.post(`/notes/books/${book.id}`).field('_csrf', csrfToken).field('expectedCoverKind', 'none');
  function counts(books = 1, managed = 0) {
    expect(db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(books);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(managed);
  }
  function files() {
    const root = path.join(tmp, 'assets');
    return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()) : [];
  }
  function source() { return db.prepare('SELECT * FROM managed_assets').get(); }
  it('preserves URL-encoded and multipart no-cover edit redirects without managed ingestion', async () => {
    for (const submission of [
      () => agent.post(`/notes/books/${book.id}`).type('form').send({ title: 'Ordinary', _csrf: csrfToken }),
      () => post().field('title', 'Multipart'),
    ]) {
      const res = await submission().expect(302);
      expect(res.headers.location).toMatch(/^\/notes\/books\/\d+$/);
    }
    counts(1, 0);
    expect(files()).toHaveLength(0);
  });
  it.each([false, true])('rerenders invalid Book fields before ingestion (cover=%s)', async (cover) => {
    const submit = post().field('title', '   ');
    if (cover) submit.attach('cover', bytes, 'private.png');
    const res = await submit.expect(422);
    expect(res.text).toMatch(/<dialog[^>]*id="book-edit-dialog"[^>]*\bopen/);
    expect(res.text).toContain('value="   "');
    expectBookCoverForm(res.text);
    expect(res.text).not.toContain('private.png');
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each([false, true])('rejects CSRF before any durable mutation (cover=%s)', async (cover) => {
    const submit = agent.post(`/notes/books/${book.id}`).field('title', 'Blocked').field('_csrf', 'invalid');
    if (cover) submit.attach('cover', bytes, 'private.png');
    await submit.expect(403);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each(['png', 'jpeg', 'webp'])('commits %s source, Book and managed selection with the existing destination', async (format) => {
    const upload = await sharp(bytes).toFormat(format).toBuffer();
    const res = await post().field('title', 'Uploaded').attach('cover', upload, { filename: 'untrusted.bin', contentType: 'application/octet-stream' }).expect(302);
    counts(1, 1);
    const savedBook = db.prepare('SELECT * FROM books').get();
    const record = source();
    expect(res.headers.location).toBe(`/notes/books/${savedBook.id}`);
    expect(record.namespace).toBe('book-covers');
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual({ kind: 'managed_asset', id: record.id });
    expect(fs.readFileSync(path.join(tmp, 'assets', record.storage_key))).toEqual(upload);
    expect(files()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.updated'").all()).toHaveLength(1);
  });
  it('rejects invalid image with a sanitized error and cleans staging', async () => {
    const res = await post().set('Accept', 'application/json').field('title', 'Valid title').attach('cover', Buffer.from('private invalid bytes'), 'C-private.png').expect(422);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      status: 'error', code: 'INVALID_IMAGE',
      message: 'A valid, single still PNG, JPEG or WebP image within the managed image limits is required.',
    });
    expect(res.text).not.toMatch(/private|stack|storage_key/);
    counts();
    expect(files()).toHaveLength(0);
  });
  it('rolls back the compound transaction and then uses supported managed rollback and compensation', async () => {
    const rollback = vi.spyOn(app.locals.managedAssetRepository, 'rollbackCommitted');
    // Fail selection after Book update, exercising the real compound transaction.
    db.exec("CREATE TEMP TRIGGER fail_cover BEFORE INSERT ON book_primary_images BEGIN SELECT RAISE(ABORT, 'private failure'); END");
    const res = await post().field('title', 'Valid').attach('cover', bytes, 'cover.png').expect(500);
    expect(res.text).not.toContain('private failure');
    expect(rollback).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.updated'").all()).toHaveLength(0);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each(['record', 'file'])('preserves foreign %s on uncertain cleanup and overrides ordinary validation failure', async (foreign) => {
    vi.spyOn(app.locals.bookService, 'updateBookWithManagedPrimaryImage').mockImplementation(() => {
      const record = source();
      if (foreign === 'record') db.prepare('UPDATE managed_assets SET width = width + 1 WHERE id = ?').run(record.id);
      else {
        const file = path.join(tmp, 'assets', record.storage_key);
        fs.renameSync(file, path.join(tmp, 'owned.png'));
        fs.writeFileSync(file, 'foreign data');
      }
      throw new BookValidationError({ title: 'Ordinary validation failure' });
    });
    const res = await post().field('title', 'Valid').attach('cover', bytes, 'cover.png').expect(500);
    expect(res.body).toEqual({ status: 'error', code: 'RECOVERY_REQUIRED', message: 'Managed image cleanup requires recovery.' });
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.cover.update_failed'").all()).toHaveLength(1);
    counts(1, foreign === 'record' ? 1 : 0);
    expect(files()).toHaveLength(1);
    if (foreign === 'file') {
      const file = files()[0];
      expect(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')).toBe('foreign data');
    }
  });
  it('preserves the hosted validation response after successful guarded cleanup of a later validation failure', async () => {
    vi.spyOn(app.locals.bookService, 'updateBookWithManagedPrimaryImage').mockImplementation(() => {
      throw new BookValidationError({ title: 'Rejected at save.' });
    });
    const res = await post().field('title', 'Preserved title').attach('cover', bytes, 'cover.png').expect(422);
    expect(res.text).toContain('value="Preserved title"');
    expect(res.text).toContain('Rejected at save.');
    expect(res.text).toMatch(/<dialog[^>]*id="book-edit-dialog"[^>]*\bopen/);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each([
    ['malformed', 400], ['field-limit', 413], ['file-limit', 413], ['wrong-type', 415],
  ])('translates %s parser failures without mutation', async (kind, status) => {
    let submit;
    if (kind === 'malformed') submit = agent.post(`/notes/books/${book.id}`).set('Content-Type', 'multipart/form-data').send('private malformed');
    if (kind === 'wrong-type') submit = agent.post(`/notes/books/${book.id}`).set('Content-Type', 'multipart/mixed; boundary=x').send('private');
    if (kind === 'field-limit') submit = post().field('title', 'x'.repeat(8193));
    if (kind === 'file-limit') submit = post().field('title', 'Valid').attach('cover', Buffer.alloc(10 * 1024 * 1024 + 1), 'private.png');
    const res = await submit.expect(status);
    expect(res.headers.connection).toBe('close');
    expect(res.text).not.toMatch(/private|stack/);
    counts();
    expect(files()).toHaveLength(0);
  });
  async function makeSource(kind, label) {
    if (kind === 'none') return null;
    if (kind === 'managed_asset') {
      const { record } = await app.locals.managedImageService.createCommittedImage({ bytes, namespace: 'book-covers' });
      return { kind, id: record.id };
    }
    const project = createProjectRepository(db).create({ title: label, slug: label,
      description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null,
      publishedDate: null, patreonUrl: null });
    const asset = createAssetRepository(db).upsert(project.id, `${label}.png`, {
      filename: `${label}.png`, extension: 'png', mimeType: 'image/png', sizeBytes: 20, modifiedAt: '2026-09-06',
    });
    return { kind, id: asset.id };
  }
  function select(source) {
    if (!source) return;
    const covers = app.locals.bookPrimaryImageService;
    if (source.kind === 'project_asset') covers.setPrimaryImage(book.id, source.id);
    else covers.setManagedPrimaryImage(book.id, source.id);
  }
  it.each(['none', 'project_asset', 'managed_asset'])('renders the current %s snapshot and resets authorization on retry', async (kind) => {
    const current = await makeSource(kind, 'form-source');
    select(current);
    const page = await agent.get(`/notes/books/${book.id}/edit`).expect(200);
    expectBookCoverForm(page.text, current);
    // Submitted source/authorization must not become the retry snapshot.
    const retry = await agent.post(`/notes/books/${book.id}`)
      .field('_csrf', csrfToken).field('title', '   ')
      .field('expectedCoverKind', 'managed_asset').field('expectedCoverId', 'stale-private-id')
      .field('coverReplacementConfirmed', 'true').attach('cover', bytes, 'private.png').expect(422);
    expectBookCoverForm(retry.text, current);
    expect(retry.text).toContain('value="   "');
    expect(retry.text).toMatch(/<dialog[^>]*id="book-edit-dialog"[^>]*\bopen/);
    expect(retry.text).not.toMatch(/stale-private-id|private\.png/);
    for (const html of [page.text, retry.text]) {
      expect(html).not.toContain(tmp);
      if (kind === 'managed_asset') {
        expect(html).not.toContain(app.locals.managedAssetRepository.findById(current.id).storage_key);
      }
    }
  });
  function upload(expected, confirmed = 'true', image = bytes) {
    let submission = agent.post(`/notes/books/${book.id}`).field('_csrf', csrfToken)
      .field('title', 'Updated').field('expectedCoverKind', expected?.kind ?? 'none');
    if (expected) submission = submission.field('expectedCoverId', String(expected.id));
    if (confirmed !== undefined && confirmed !== null) submission = submission.field('coverReplacementConfirmed', confirmed);
    return submission.attach('cover', image, 'cover.png');
  }
  function retained(source) {
    if (source.kind === 'project_asset') expect(createAssetRepository(db).findById(source.id)).toBeDefined();
    else {
      const record = app.locals.managedAssetRepository.findById(source.id);
      expect(record).toBeDefined();
      expect(fs.readFileSync(path.join(tmp, 'assets', record.storage_key))).toEqual(bytes);
    }
  }
  it.each(['project_asset', 'managed_asset'])('hosts invalid replacement validation and preserves the current %s cover', async (kind) => {
    const current = await makeSource(kind, 'original-cover');
    select(current);
    const originalBook = app.locals.bookService.getBook(book.id);
    const originalRecords = db.prepare('SELECT * FROM managed_assets').all();
    const originalFiles = files();
    const res = await upload(current, 'true', Buffer.from('private invalid bytes'))
      .set('Accept', 'text/html').expect(422);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('class="notes-page-detail-layout"');
    expect(res.text).toContain(`/notes/books/${book.id}/chapters/new`);
    const dialog = res.text.match(/<dialog[^>]*id="book-edit-dialog"[^>]*\bopen[\s\S]*?<\/dialog>/)?.[0];
    expect(dialog).toContain('value="Updated"');
    expect(dialog).toContain('<div class="error-summary" role="alert"><p>A valid, single still PNG, JPEG or WebP image within the managed image limits is required.</p></div>');
    expectBookCoverForm(res.text, current);
    expect(res.text).not.toMatch(/private invalid bytes|storage_key/);
    expect(res.text).not.toContain(tmp);
    for (const record of originalRecords) expect(res.text).not.toContain(record.storage_key);
    expect(app.locals.bookService.getBook(book.id)).toEqual(originalBook);
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(current);
    retained(current);
    expect(db.prepare('SELECT * FROM managed_assets').all()).toEqual(originalRecords);
    expect(files()).toEqual(originalFiles);
    expect(fs.readdirSync(path.join(tmp, 'assets', '.staging'))).toEqual([]);
    await app.locals.managedUploadTracker.waitForIdle();
    expect(app.locals.managedUploadTracker.activeCount).toBe(0);
    const owner = app.locals.managedUploadTracker.tryBeginMaintenance();
    expect(owner).not.toBeNull();
    owner.release();
  });
  it.each(['project_asset', 'managed_asset'])('replaces confirmed %s and retains the old source', async (kind) => {
    const old = await makeSource(kind, 'old');
    select(old);
    await upload(old).expect(302).expect('Location', `/notes/books/${book.id}`);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Updated');
    const selected = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    expect(selected.kind).toBe('managed_asset');
    expect(selected).not.toEqual(old);
    retained(old);
    counts(1, kind === 'managed_asset' ? 2 : 1);
  });
  it.each(['project_asset', 'managed_asset'])('requires explicit true confirmation for %s before ingestion', async (kind) => {
    const old = await makeSource(kind, 'old');
    select(old);
    const before = files().length;
    for (const confirmed of [null, 'false', '1', 'on', 'TRUE']) {
      const res = await upload(old, confirmed).expect(422);
      expect(res.text).toMatch(/<dialog[^>]*id="book-edit-dialog"[^>]*\bopen/);
      expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(old);
      expect(app.locals.bookService.getBook(book.id).title).toBe('Original');
      expect(files()).toHaveLength(before);
    }
    counts(1, kind === 'managed_asset' ? 1 : 0);
  });
  it.each([
    ['project_asset', 'project_asset'], ['project_asset', 'managed_asset'],
    ['managed_asset', 'project_asset'], ['managed_asset', 'managed_asset'],
    ['none', 'project_asset'], ['none', 'managed_asset'],
  ])('rejects stale %s -> %s inside the compound transaction and compensates', async (from, to) => {
    const old = await makeSource(from, 'old');
    const newer = await makeSource(to, 'newer');
    select(old);
    const before = files().length;
    const original = app.locals.bookService.updateBookWithManagedPrimaryImage;
    vi.spyOn(app.locals.bookService, 'updateBookWithManagedPrimaryImage').mockImplementation((...args) => {
      // Race after ingestion, immediately before the real guarded transaction.
      select(newer);
      return original(...args);
    });
    const rollback = vi.spyOn(app.locals.managedAssetRepository, 'rollbackCommitted');
    const res = await upload(old, old ? 'true' : null).expect(409);
    expect(res.body.code).toBe('STALE_SOURCE');
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(newer);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Original');
    expect(rollback).toHaveBeenCalledOnce();
    expect(files()).toHaveLength(before);
    counts(1, Number(from === 'managed_asset') + Number(to === 'managed_asset'));
    if (old) retained(old);
    retained(newer);
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.updated'").all()).toHaveLength(0);
  });
  it.each(['project_asset', 'managed_asset'])('no-cover edit preserves %s and ignores upload-only fields', async (kind) => {
    const old = await makeSource(kind, 'old');
    select(old);
    for (const multipart of [false, true]) {
      const fields = { title: 'Text only', _csrf: csrfToken, expectedCoverKind: 'invalid', coverReplacementConfirmed: 'false' };
      let submission = agent.post(`/notes/books/${book.id}`);
      if (multipart) for (const [name, value] of Object.entries(fields)) submission = submission.field(name, value);
      else submission = submission.type('form').send(fields);
      await submission.expect(302).expect('Location', `/notes/books/${book.id}`);
      expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(old);
    }
    counts(1, kind === 'managed_asset' ? 1 : 0);
    retained(old);
  });
  it.each(['project_asset', 'managed_asset'])('compound persistence failure retains %s and rolls back new row/file', async (kind) => {
    const old = await makeSource(kind, 'old');
    select(old);
    const before = files().length;
    db.exec("CREATE TEMP TRIGGER fail_replace BEFORE UPDATE ON book_primary_images BEGIN SELECT RAISE(ABORT, 'private failure'); END");
    const res = await upload(old).expect(500);
    expect(res.text).not.toContain('private failure');
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(old);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Original');
    expect(files()).toHaveLength(before);
    counts(1, kind === 'managed_asset' ? 1 : 0);
    retained(old);
  });
  it.each(['project_asset', 'managed_asset'])('invalid image preserves current %s and Book fields', async (kind) => {
    const old = await makeSource(kind, 'old');
    select(old);
    const before = files().length;
    await upload(old, 'true', Buffer.from('invalid')).expect(422);
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(old);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Original');
    expect(files()).toHaveLength(before);
    retained(old);
  });
  it.each([
    {}, { expectedCoverKind: 'project_asset', expectedCoverId: '01' },
    { expectedCoverKind: 'project_asset', expectedCoverId: '9007199254740992' },
    { expectedCoverKind: 'managed_asset', expectedCoverId: '' },
    { expectedCoverKind: 'none', expectedCoverId: '1' },
  ])('rejects missing or malformed expected identity %j before ingestion', async (fields) => {
    let submission = agent.post(`/notes/books/${book.id}`).field('_csrf', csrfToken).field('title', 'Updated');
    for (const [name, value] of Object.entries(fields)) submission = submission.field(name, value);
    await submission.attach('cover', bytes, 'cover.png').expect(422);
    counts();
    expect(files()).toHaveLength(0);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Original');
  });
  it('does not extend pre-CSRF parsing to reorder or nested Book actions', async () => {
    for (const endpoint of ['reorder', `${book.id}/delete`, `${book.id}/chapters`]) {
      await agent.post(`/notes/books/${endpoint}`).field('_csrf', csrfToken).field('title', 'Blocked').expect(403);
    }
    counts();
  });
  it('retains tracking through a response write failure without undoing durable state', async () => {
    vi.spyOn(app.response, 'redirect').mockImplementation(() => {
      expect(app.locals.managedUploadTracker.activeCount).toBe(1);
      throw new Error('response unavailable');
    });
    await agent.post(`/notes/books/${book.id}`).field('_csrf', csrfToken).field('title', 'Valid').field('expectedCoverKind', 'none').attach('cover', bytes, 'cover.png').expect(500);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM book_primary_images').get().n).toBe(1);
    expect(files()).toHaveLength(1);
  });
  it('handles a real HTTP abort during partial multipart input without mutation', async () => {
    const started = deferred();
    const closed = deferred();
    const server = http.createServer((req, res) => {
      req.once('data', () => started.resolve());
      res.once('close', () => closed.resolve());
      app(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = http.request({ host: '127.0.0.1', port: server.address().port,
      method: 'POST', path: `/notes/books/${book.id}`, headers: { 'Content-Type': 'multipart/form-data; boundary=abort-test' } });
    client.on('error', () => {});
    try {
      client.write('--abort-test\r\nContent-Disposition: form-data; name="cover"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\npartial');
      await started.promise;
      client.destroy();
      await closed.promise;
      await new Promise((resolve) => setImmediate(resolve));
      counts();
      expect(files()).toHaveLength(0);
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('cleans a disconnected request after in-flight ingestion settles, without updating the Book', async () => {
    const entered = deferred();
    const release = deferred();
    const original = app.locals.managedAssetRepository.insertCommitted;
    vi.spyOn(app.locals.managedAssetRepository, 'insertCommitted').mockImplementation((metadata) => {
      expect(app.locals.managedUploadTracker.hasActive()).toBe(true);
      const result = original(metadata);
      entered.resolve();
      return result;
    });
    // Deterministic adapter seam: real ingestion and guarded cleanup, response
    // state changes at a controlled asynchronous boundary, no socket timing race.
    const res = { destroyed: false };
    const service = {
      ...app.locals.managedImageService,
      async createCommittedImage(input) {
        const created = await app.locals.managedImageService.createCommittedImage(input);
        await release.promise;
        return created;
      },
    };
    const result = updateBookWithUploadedCover({ body: { title: 'Aborted', expectedCoverKind: 'none' }, aborted: false }, res,
      { bookService: app.locals.bookService, managedImageService: service }, book.id, bytes);
    await entered.promise;
    res.destroyed = true;
    release.resolve();
    expect(await result).toBeNull();
    expect(app.locals.bookService.getBook(book.id).title).toBe('Original');
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toBeNull();
    counts();
    expect(files()).toHaveLength(0);
  });
  it('skips ingestion if already aborted and never compensates after durable Book commit', async () => {
    const service = { ...app.locals.managedImageService, createCommittedImage: vi.fn(app.locals.managedImageService.createCommittedImage), rollbackCommitted: vi.fn() };
    const res = { destroyed: false };
    const req = { body: { title: 'Committed', expectedCoverKind: 'none' }, aborted: true };
    expect(await updateBookWithUploadedCover(req, res, { bookService: app.locals.bookService, managedImageService: service }, book.id, bytes)).toBeNull();
    expect(service.createCommittedImage).not.toHaveBeenCalled();
    req.aborted = false;
    const original = app.locals.bookService.updateBookWithManagedPrimaryImage;
    vi.spyOn(app.locals.bookService, 'updateBookWithManagedPrimaryImage').mockImplementation((...args) => {
      const book = original(...args);
      res.destroyed = true;
      return book;
    });
    expect(await updateBookWithUploadedCover(req, res, { bookService: app.locals.bookService, managedImageService: service }, book.id, bytes)).toHaveProperty('id');
    counts(1, 1);
    expect(files()).toHaveLength(1);
    expect(service.rollbackCommitted).not.toHaveBeenCalled();
  });
});

const updateBookWithUploadedCover = admittedUpload(updateBookWithUploadedCoverHandler);
