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
import { EventEmitter } from 'node:events';
import { admitBookUpload } from '../src/middleware/book-upload-lifetime.js';
import { createApp } from '../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';
import { BookValidationError } from '../src/services/book-service.js';
import { createBookWithUploadedCover as createBookWithUploadedCoverHandler } from '../src/middleware/book-create-multipart.js';
import { parseBookCoverMultipart } from '../src/services/book-cover-multipart.js';

vi.mock('../src/services/book-cover-multipart.js', async (original) => {
  const actual = await original();
  return { ...actual, parseBookCoverMultipart: vi.fn(actual.parseBookCoverMultipart) };
});
vi.mock('../src/services/managed-image-service.js', async (original) => {
  const actual = await original();
  return { ...actual, createManagedImageService: (...args) => ({ ...actual.createManagedImageService(...args) }) };
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('WP7D2A New Book multipart HTTP', () => {
  let tmp, db, app, agent, csrfToken, bytes;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp7d2a-'));
    db = openDatabase(':memory:');
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
    app = createApp({ appName: 'CreatorCrate', db, previewRoot: path.join(tmp, 'previews') }, {
      appDataRoot: tmp, authConfig: AUTH_CONFIG,
    });
    ({ agent, csrfToken } = await authenticate(app));
    bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  });
  afterEach(() => {
    expect(app.locals.managedUploadTracker.hasActive()).toBe(false);
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const post = () => agent.post('/notes/books').field('_csrf', csrfToken);
  it('creates one Book from the raw browser placeholder without ingestion or staging', async () => {
    const ingestion = vi.spyOn(app.locals.managedImageService, 'createCommittedImage');
    const before = fs.readdirSync(tmp, { recursive: true });
    const wire = Buffer.from(`--native\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrfToken}\r\n--native\r\nContent-Disposition: form-data; name="title"\r\n\r\nNative empty cover\r\n--native\r\nContent-Disposition: form-data; name="cover"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--native--\r\n`);
    const res = await agent.post('/notes/books').set('Content-Type', 'multipart/form-data; boundary=native')
      .send(wire).expect(302);
    counts(1, 0);
    const book = db.prepare('SELECT * FROM books').get();
    expect(book.title).toBe('Native empty cover');
    expect(res.headers.location).toBe(`/notes/books/${book.id}`);
    expect(db.prepare('SELECT * FROM book_primary_images').all()).toEqual([]);
    expect(ingestion).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp, { recursive: true })).toEqual(before);
  });
  function counts(books = 0, managed = 0) {
    expect(db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(books);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(managed);
  }
  function files() {
    const root = path.join(tmp, 'assets');
    return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()) : [];
  }
  function source() { return db.prepare('SELECT * FROM managed_assets').get(); }
  it.each(['/notes/books', '/NOTES/BOOKS/1/'])('admits %s before partial multipart parsing finishes', async (route) => {
    const entered = deferred();
    const ingestion = vi.spyOn(app.locals.managedImageService, 'createCommittedImage');
    const server = http.createServer((req, res) => {
      req.once('data', () => entered.resolve(req));
      app(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = http.request({ host: '127.0.0.1', port: server.address().port,
      method: 'POST', path: route, headers: { 'Content-Type': 'multipart/form-data; boundary=early' } });
    const response = new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('response', (res) => { res.resume(); res.on('end', () => resolve(res)); });
    });
    try {
      client.write('--early\r\nContent-Disposition: form-data; name="title"\r\n\r\nPartial');
      const req = await entered.promise;
      const lease = req.bookUploadLifetime.operation;
      expect(app.locals.managedUploadTracker.activeCount).toBe(1);
      expect(app.locals.managedUploadTracker.tryBeginMaintenance()).toBeNull();
      expect(lease.signal.aborted).toBe(false);
      expect(ingestion).not.toHaveBeenCalled();
      client.end('\r\n--early--\r\n');
      expect((await response).statusCode).toBe(401);
      expect(req.bookUploadLifetime.operation).toBe(lease);
      expect(app.locals.managedUploadTracker.activeCount).toBe(0);
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it.each(['/notes/books', '/notes/books/1'])('refuses maintenance-first %s before parsing, session, CSRF or ingestion', async (route) => {
    parseBookCoverMultipart.mockClear();
    const ingestion = vi.spyOn(app.locals.managedImageService, 'createCommittedImage');
    const validateNew = vi.spyOn(app.locals.bookService, 'validateCreateBook');
    const validateEdit = vi.spyOn(app.locals.bookService, 'validateUpdateBook');
    const json = app.response.json;
    vi.spyOn(app.response, 'json').mockImplementation(function (...args) {
      expect(this.locals.auth).toBeUndefined();
      expect(this.locals._csrf).toBeUndefined();
      return json.apply(this, args);
    });
    const owner = app.locals.managedUploadTracker.tryBeginMaintenance();
    try {
      app.locals.maintenanceState.active = false;
      const res = await agent.post(route).set('Accept', 'application/json')
        .field('_csrf', csrfToken).attach('cover', bytes, 'cover.png').expect(503);
      expect(res.body).toEqual({ status: 'error', message: 'Service temporarily unavailable for maintenance.' });
      expect(parseBookCoverMultipart).not.toHaveBeenCalled();
      expect(ingestion).not.toHaveBeenCalled();
      expect(validateNew).not.toHaveBeenCalled();
      expect(validateEdit).not.toHaveBeenCalled();
      expect(app.locals.managedUploadTracker.activeCount).toBe(0);
    } finally { owner.release(); }
  });
  it.each(['new', 'edit'].flatMap((mode) => [[mode, false], [mode, true]]))('retains one %s lease through asynchronous 422 rendering and disconnect (invalid cover=%s)', async (mode, invalidCover) => {
    const book = app.locals.bookService.createBook({ title: 'Existing' });
    const entered = deferred();
    const gate = deferred();
    const rendered = deferred();
    let serverResponse;
    const responseRender = app.response.render;
    vi.spyOn(app.response, 'render').mockImplementation(function (...args) {
      serverResponse = this;
      return responseRender.apply(this, args);
    });
    const originalRender = app.render;
    vi.spyOn(app, 'render').mockImplementation(function (view, options, callback) {
      entered.resolve(options);
      gate.promise.then(() => {
        expect(app.locals.managedUploadTracker.activeCount).toBe(1);
        originalRender.call(this, view, options, (...args) => {
          try { callback(...args); } finally { rendered.resolve(); }
        });
      });
    });
    const ingestion = vi.spyOn(app.locals.managedImageService, 'createCommittedImage');
    const submit = agent.post(mode === 'new' ? '/notes/books' : `/notes/books/${book.id}`)
      .set('Accept', 'text/html').field('_csrf', csrfToken).field('expectedCoverKind', 'none')
      .field('title', invalidCover ? 'Valid title' : '   ');
    if (invalidCover) submit.attach('cover', Buffer.from('invalid bytes'), 'invalid.png');
    const result = submit.then((res) => res);
    await entered.promise;
    expect(app.locals.managedUploadTracker.activeCount).toBe(1);
    expect(ingestion).toHaveBeenCalledTimes(invalidCover ? 1 : 0);
    expect(app.locals.managedUploadTracker.tryBeginMaintenance()).toBeNull();
    // Controlled server-side disconnect while the real template callback waits.
    serverResponse.emit('close');
    expect(serverResponse.req.bookUploadLifetime.operation.signal.aborted).toBe(true);
    expect(app.locals.managedUploadTracker.activeCount).toBe(1);
    gate.resolve();
    await rendered.promise;
    expect((await result).status).toBe(422);
    expect(app.locals.managedUploadTracker.activeCount).toBe(0);
    const owner = app.locals.managedUploadTracker.tryBeginMaintenance();
    expect(owner).not.toBeNull();
    owner.release();
  });
  it('keeps two HTTP uploads concurrent and excludes maintenance until both finish', async () => {
    const server = agent.app;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const gates = [deferred(), deferred()];
    const bothEntered = deferred();
    const original = app.locals.managedImageService.createCommittedImage;
    let started = 0;
    vi.spyOn(app.locals.managedImageService, 'createCommittedImage').mockImplementation(async (input) => {
      const index = started++;
      if (started === 2) bothEntered.resolve();
      await gates[index].promise;
      return original(input);
    });
    const results = [0, 1].map((i) => post().field('title', `Concurrent ${i}`)
      .attach('cover', bytes, 'cover.png').then((res) => res));
    try {
      await bothEntered.promise;
      expect(app.locals.managedUploadTracker.activeCount).toBe(2);
      gates[0].resolve();
      expect((await Promise.race(results)).status).toBe(302);
      expect(app.locals.managedUploadTracker.activeCount).toBe(1);
      expect(app.locals.managedUploadTracker.tryBeginMaintenance()).toBeNull();
      gates[1].resolve();
      expect((await Promise.all(results)).every((res) => res.status === 302)).toBe(true);
      expect(app.locals.managedUploadTracker.activeCount).toBe(0);
      const owner = app.locals.managedUploadTracker.tryBeginMaintenance();
      expect(owner).not.toBeNull();
      owner.release();
    } finally {
      for (const gate of gates) gate.resolve();
      await Promise.allSettled(results);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('preserves URL-encoded and multipart no-cover create redirects without managed ingestion', async () => {
    for (const submission of [
      () => agent.post('/notes/books').type('form').send({ title: 'Ordinary', _csrf: csrfToken }),
      () => post().field('title', 'Multipart'),
    ]) {
      const res = await submission().expect(302);
      expect(res.headers.location).toMatch(/^\/notes\/books\/\d+$/);
    }
    counts(2, 0);
    expect(files()).toHaveLength(0);
  });
  it.each([false, true])('rerenders invalid Book fields before ingestion (cover=%s)', async (cover) => {
    const submit = post().field('title', '   ');
    if (cover) submit.attach('cover', bytes, 'private.png');
    const res = await submit.expect(422);
    expect(res.text).toMatch(/<dialog[^>]*id="book-create-dialog"[^>]*\bopen/);
    expect(res.text).toContain('value="   "');
    expectBookCoverForm(res.text);
    expect(res.text).not.toContain('private.png');
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each([false, true])('rejects CSRF before any durable mutation (cover=%s)', async (cover) => {
    const submit = agent.post('/notes/books').field('title', 'Blocked').field('_csrf', 'invalid');
    if (cover) submit.attach('cover', bytes, 'private.png');
    await submit.expect(403);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each(['png', 'jpeg', 'webp'])('commits %s source, Book and managed selection with the existing destination', async (format) => {
    const upload = await sharp(bytes).toFormat(format).toBuffer();
    const res = await post().field('title', 'Uploaded').attach('cover', upload, { filename: 'untrusted.bin', contentType: 'application/octet-stream' }).expect(302);
    counts(1, 1);
    const book = db.prepare('SELECT * FROM books').get();
    const record = source();
    expect(res.headers.location).toBe(`/notes/books/${book.id}`);
    expect(record.namespace).toBe('book-covers');
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual({ kind: 'managed_asset', id: record.id });
    expect(fs.readFileSync(path.join(tmp, 'assets', record.storage_key))).toEqual(upload);
    expect(files()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.created'").all()).toHaveLength(1);
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
  it.each(['text/html', '*/*'])('hosts invalid cover validation on Books for Accept: %s', async (accept) => {
    const res = await post().set('Accept', accept).field('title', 'Preserved upload title')
      .attach('cover', Buffer.from('private invalid bytes'), 'C-private.png').expect(422);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('class="notes-books-index"');
    const dialog = res.text.match(/<dialog[^>]*id="book-create-dialog"[^>]*\bopen[\s\S]*?<\/dialog>/)?.[0];
    expect(dialog).toContain('value="Preserved upload title"');
    expect(dialog).toContain('<div class="error-summary" role="alert"><p>A valid, single still PNG, JPEG or WebP image within the managed image limits is required.</p></div>');
    expectBookCoverForm(res.text);
    expect(res.text).not.toMatch(/C-private|private invalid bytes|storage_key/);
    expect(res.text).not.toContain(tmp);
    counts();
    expect(files()).toHaveLength(0);
    expect(fs.readdirSync(path.join(tmp, 'assets', '.staging'))).toEqual([]);
    await app.locals.managedUploadTracker.waitForIdle();
    expect(app.locals.managedUploadTracker.activeCount).toBe(0);
    const owner = app.locals.managedUploadTracker.tryBeginMaintenance();
    expect(owner).not.toBeNull();
    owner.release();
  });
  it('rolls back the compound transaction and then uses supported managed rollback and compensation', async () => {
    const rollback = vi.spyOn(app.locals.managedAssetRepository, 'rollbackCommitted');
    // Fail selection after Book insertion, exercising the real compound transaction.
    db.exec("CREATE TEMP TRIGGER fail_cover BEFORE INSERT ON book_primary_images BEGIN SELECT RAISE(ABORT, 'private failure'); END");
    const res = await post().field('title', 'Valid').attach('cover', bytes, 'cover.png').expect(500);
    expect(res.text).not.toContain('private failure');
    expect(rollback).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.created'").all()).toHaveLength(0);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each(['record', 'file'])('preserves foreign %s on uncertain cleanup and overrides ordinary validation failure', async (foreign) => {
    vi.spyOn(app.locals.bookService, 'createBookWithManagedPrimaryImage').mockImplementation(() => {
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
    expect(db.prepare("SELECT * FROM application_logs WHERE event = 'book.cover.create_failed'").all()).toHaveLength(1);
    counts(0, foreign === 'record' ? 1 : 0);
    expect(files()).toHaveLength(1);
    if (foreign === 'file') {
      const file = files()[0];
      expect(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')).toBe('foreign data');
    }
  });
  it('preserves the hosted validation response after successful guarded cleanup of a later validation failure', async () => {
    vi.spyOn(app.locals.bookService, 'createBookWithManagedPrimaryImage').mockImplementation(() => {
      throw new BookValidationError({ title: 'Rejected at save.' });
    });
    const res = await post().field('title', 'Preserved title').attach('cover', bytes, 'cover.png').expect(422);
    expect(res.text).toContain('value="Preserved title"');
    expect(res.text).toContain('Rejected at save.');
    expect(res.text).toMatch(/<dialog[^>]*id="book-create-dialog"[^>]*\bopen/);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each([
    ['malformed', 400], ['field-limit', 413], ['file-limit', 413], ['wrong-type', 415],
  ])('translates %s parser failures without mutation', async (kind, status) => {
    let submit;
    if (kind === 'malformed') submit = agent.post('/notes/books').set('Content-Type', 'multipart/form-data').send('private malformed');
    if (kind === 'wrong-type') submit = agent.post('/notes/books').set('Content-Type', 'multipart/mixed; boundary=x').send('private');
    if (kind === 'field-limit') submit = post().field('title', 'x'.repeat(8193));
    if (kind === 'file-limit') submit = post().field('title', 'Valid').attach('cover', Buffer.alloc(10 * 1024 * 1024 + 1), 'private.png');
    const res = await submit.expect(status);
    expect(res.headers.connection).toBe('close');
    expect(res.text).not.toMatch(/private|stack/);
    counts();
    expect(files()).toHaveLength(0);
  });
  it.each(['new', 'edit'])('retains %s tracking through a response write failure without undoing durable state', async (mode) => {
    const book = mode === 'edit' ? app.locals.bookService.createBook({ title: 'Existing' }) : null;
    vi.spyOn(app.response, 'redirect').mockImplementation(() => {
      expect(app.locals.managedUploadTracker.activeCount).toBe(1);
      throw new Error('response unavailable');
    });
    await agent.post(book ? `/notes/books/${book.id}` : '/notes/books')
      .field('_csrf', csrfToken).field('expectedCoverKind', 'none')
      .field('title', 'Valid').attach('cover', bytes, 'cover.png').expect(500);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM book_primary_images').get().n).toBe(1);
    expect(files()).toHaveLength(1);
  });
  it.each(['headers-sent entry', 'final renderer'].flatMap((failurePath) => [
    ['new', true, failurePath], ['edit', true, failurePath],
    ['new', false, failurePath], ['edit', false, failurePath],
  ]))('terminates %s with cover=%s through %s without undoing commits', async (mode, cover, failurePath) => {
    const book = mode === 'edit' ? app.locals.bookService.createBook({ title: 'Existing' }) : null;
    const tracker = app.locals.managedUploadTracker;
    const closed = deferred();
    const idle = deferred();
    let response;
    let end;
    const rollback = vi.spyOn(app.locals.managedImageService, 'rollbackCommitted');
    const compensate = vi.spyOn(app.locals.managedImageService, 'compensate');
    const failure = new Error('injected terminal response failure');
    const forwarded = vi.fn();
    app.use((error, _req, _res, next) => { forwarded(error); next(error); });
    const render = vi.spyOn(app.response, 'render');
    if (failurePath === 'final renderer') {
      vi.spyOn(app.response, 'send').mockImplementation(function () {
        expect(render).toHaveBeenCalledWith('error.njk', expect.any(Object), expect.any(Function));
        expect(this.headersSent).toBe(false);
        this.writeHead(500);
        throw failure;
      });
    }
    vi.spyOn(app.response, 'redirect').mockImplementation(function () {
      response = this;
      end = vi.spyOn(this, 'end');
      this.once('close', closed.resolve);
      tracker.waitForIdle().then(idle.resolve);
      if (failurePath === 'final renderer') {
        expect(this.headersSent).toBe(false);
        throw new Error('injected pre-headers redirect failure');
      }
      this.writeHead(302, { Location: '/notes' });
      expect(this.headersSent).toBe(true);
      expect(tracker.activeCount).toBe(1);
      throw failure;
    });
    let submit = agent.post(book ? `/notes/books/${book.id}` : '/notes/books')
      .field('_csrf', csrfToken).field('expectedCoverKind', 'none').field('title', 'Durable');
    if (cover) submit = submit.attach('cover', bytes, 'cover.png');
    await expect(submit).rejects.toThrow();
    await closed.promise;
    expect(response.writableEnded).toBe(false);
    expect(response.headersSent).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(forwarded).toHaveBeenCalledExactlyOnceWith(failure);
    expect(end).not.toHaveBeenCalled();
    expect(tracker.activeCount).toBe(0);
    await idle.promise;
    const owner = tracker.tryBeginMaintenance();
    expect(owner).not.toBeNull();
    owner.release();
    counts(1, cover ? 1 : 0);
    expect(db.prepare('SELECT title FROM books').get().title).toBe('Durable');
    expect(db.prepare('SELECT count(*) AS n FROM book_primary_images').get().n).toBe(cover ? 1 : 0);
    expect(files()).toHaveLength(cover ? 1 : 0);
    if (cover) expect(fs.readFileSync(path.join(tmp, 'assets', source().storage_key))).toEqual(bytes);
    expect(rollback).not.toHaveBeenCalled();
    expect(compensate).not.toHaveBeenCalled();
  });
  it.each(['headers-sent entry', 'final renderer'].flatMap((failurePath) => [
    [false, failurePath], [true, failurePath],
  ]))('protects pending graph work (concurrent=%s) through %s', async (concurrent, failurePath) => {
    const tracker = app.locals.managedUploadTracker;
    const closed = deferred();
    let release;
    let lifetime;
    const otherReq = new EventEmitter();
    const otherRes = new EventEmitter();
    const other = concurrent ? admitBookUpload(otherReq, otherRes, tracker) : null;
    const drained = vi.fn();
    let idle;
    if (failurePath === 'final renderer') {
      vi.spyOn(app.response, 'send').mockImplementation(function () {
        expect(this.headersSent).toBe(false);
        this.writeHead(500);
        throw new Error('injected final renderer failure with pending graph work');
      });
    }
    vi.spyOn(app.response, 'redirect').mockImplementation(function () {
      lifetime = this.req.bookUploadLifetime;
      release = lifetime.hold();
      idle = tracker.waitForIdle().then(drained);
      this.once('close', closed.resolve);
      if (failurePath === 'headers-sent entry') this.writeHead(302);
      expect(tracker.activeCount).toBe(concurrent ? 2 : 1);
      throw new Error('injected post-headers failure with pending graph work');
    });
    try {
      await expect(post().field('title', 'Durable')).rejects.toThrow();
      await closed.promise;
      expect(lifetime.operation.signal.aborted).toBe(true);
      expect(tracker.activeCount).toBe(concurrent ? 2 : 1);
      expect(tracker.tryBeginMaintenance()).toBeNull();
      expect(drained).not.toHaveBeenCalled();
      release();
      await Promise.resolve();
      expect(tracker.activeCount).toBe(concurrent ? 1 : 0);
      if (concurrent) {
        expect(tracker.tryBeginMaintenance()).toBeNull();
        expect(drained).not.toHaveBeenCalled();
        otherRes.emit('close');
        expect(tracker.activeCount).toBe(1);
        other.terminal();
      }
      await idle;
      expect(tracker.activeCount).toBe(0);
      expect(drained).toHaveBeenCalledOnce();
      const owner = tracker.tryBeginMaintenance();
      expect(owner).not.toBeNull();
      owner.release();
    } finally {
      release?.();
      other?.terminal();
    }
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
      method: 'POST', path: '/notes/books', headers: { 'Content-Type': 'multipart/form-data; boundary=abort-test' } });
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
  it('cleans a disconnected request after in-flight ingestion settles, without creating a Book', async () => {
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
    const result = createBookWithUploadedCover({ body: { title: 'Aborted' }, aborted: false }, res,
      { bookService: app.locals.bookService, managedImageService: service }, bytes);
    await entered.promise;
    res.destroyed = true;
    release.resolve();
    expect(await result).toBeNull();
    counts();
    expect(files()).toHaveLength(0);
  });
  it('skips ingestion if already aborted and never compensates after durable Book commit', async () => {
    const service = { ...app.locals.managedImageService, createCommittedImage: vi.fn(app.locals.managedImageService.createCommittedImage), rollbackCommitted: vi.fn() };
    const res = { destroyed: false };
    const req = { body: { title: 'Committed' }, aborted: true };
    expect(await createBookWithUploadedCover(req, res, { bookService: app.locals.bookService, managedImageService: service }, bytes)).toBeNull();
    expect(service.createCommittedImage).not.toHaveBeenCalled();
    req.aborted = false;
    const original = app.locals.bookService.createBookWithManagedPrimaryImage;
    vi.spyOn(app.locals.bookService, 'createBookWithManagedPrimaryImage').mockImplementation((...args) => {
      const book = original(...args);
      res.destroyed = true;
      return book;
    });
    expect(await createBookWithUploadedCover(req, res, { bookService: app.locals.bookService, managedImageService: service }, bytes)).toHaveProperty('id');
    counts(1, 1);
    expect(files()).toHaveLength(1);
    expect(service.rollbackCommitted).not.toHaveBeenCalled();
  });
});

const createBookWithUploadedCover = admittedUpload(createBookWithUploadedCoverHandler);
