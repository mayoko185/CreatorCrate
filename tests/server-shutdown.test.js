import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';

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
let tmp, db, app, tracker, createShutdownHandler, closeDatabase, lifetime, bytes;
beforeEach(async () => {
  // Permanent closure is reset only by loading a fresh process module graph.
  vi.resetModules();
  ({ createShutdownHandler } = await import('../src/server.js'));
  const database = await import('../src/db.js');
  closeDatabase = database.closeDatabase;
  db = database.openDatabase(':memory:');
  database.runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shutdown-'));
  const { createApp } = await import('../src/app.js');
  app = createApp({ appName: 'CreatorCrate', db, previewRoot: path.join(tmp, 'previews') }, { appDataRoot: tmp });
  tracker = app.locals.managedUploadTracker;
  lifetime = await import('../src/middleware/book-upload-lifetime.js');
  bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
});
afterEach(() => {
  expect(tracker.activeCount).toBe(0);
  vi.restoreAllMocks();
  if (db.open) closeDatabase(db);
  fs.rmSync(tmp, { recursive: true, force: true });
});
function shutdownHarness() {
  const events = [];
  const vite = deferred();
  const httpClosing = deferred();
  let finishHttp;
  const retireDatabase = vi.fn((connection) => { events.push('database'); closeDatabase(connection); });
  const exit = vi.fn(() => events.push('exit'));
  const shutdown = createShutdownHandler({
    appContext: { get db() { return db; } },
    applicationLogger: { info: ({ event }) => events.push(event) },
    automaticProjectScanScheduler: { stop: () => events.push('scheduler') },
    viteServer: { close: () => { events.push('vite'); return vite.promise; } },
    server: { close: (callback) => { events.push('http'); finishHttp = callback; httpClosing.resolve(); } },
    retireDatabase, exit,
  });
  return { events, shutdown, retireDatabase, exit, async finishNetwork() {
    vite.resolve();
    await httpClosing.promise;
    finishHttp();
    await Promise.resolve();
  } };
}
function admitted(handler) {
  const req = Object.assign(new EventEmitter(), { body: { title: 'Saved', expectedCoverKind: 'none' } });
  const res = new EventEmitter();
  lifetime.admitBookUpload(req, res, tracker);
  const result = lifetime.withBookUploadLifetime(handler)(req, res, (err) => {
    req.bookUploadLifetime.terminal();
    throw err;
  });
  return { req, res, result };
}
it('closes admission synchronously, preserves network ordering, and drains before database/exit', async () => {
  const gate = deferred();
  const work = admitted(async () => { await gate.promise; expect(db.open).toBe(true); });
  const h = shutdownHarness();
  const stopping = h.shutdown();
  expect(tracker.begin()).toBeNull();
  expect(work.req.bookUploadLifetime.operation.signal.aborted).toBe(false);
  expect(h.events.slice(-2)).toEqual(['scheduler', 'vite']);
  await h.shutdown(); // Repeated signal does not start a second shutdown.
  await h.finishNetwork();
  expect(h.retireDatabase).not.toHaveBeenCalled();
  expect(db.open).toBe(true);
  gate.resolve();
  await work.result;
  await stopping;
  expect(h.events.slice(-4)).toEqual(['http', 'runtime.shutdown.completed', 'database', 'exit']);
  expect(h.exit).toHaveBeenCalledWith(0);
});
it.each(['/notes/books', '/notes/books/1'])('refuses shutdown-first %s before multipart and graph work', async (route) => {
  const { parseBookCoverMultipart } = await import('../src/services/book-cover-multipart.js');
  parseBookCoverMultipart.mockClear();
  const ingestion = vi.spyOn(app.locals.managedImageService, 'createCommittedImage');
  const validateNew = vi.spyOn(app.locals.bookService, 'validateCreateBook');
  const validateEdit = vi.spyOn(app.locals.bookService, 'validateUpdateBook');
  const json = app.response.json;
  vi.spyOn(app.response, 'json').mockImplementation(function (...args) {
    expect(this.locals.auth).toBeUndefined();
    expect(this.locals._csrf).toBeUndefined();
    expect(this.req.bookUploadLifetime).toBeUndefined();
    return json.apply(this, args);
  });
  const owner = tracker.tryBeginMaintenance();
  tracker.beginShutdown();
  owner.release();
  app.locals.maintenanceState.active = false;
  const res = await request(app).post(route).set('Accept', 'application/json')
    .field('_csrf', 'invalid').attach('cover', bytes, 'cover.png').expect(503);
  expect(res.body).toEqual({ status: 'error', message: 'Service temporarily unavailable for maintenance.' });
  expect(parseBookCoverMultipart).not.toHaveBeenCalled();
  expect(ingestion).not.toHaveBeenCalled();
  expect(validateNew).not.toHaveBeenCalled();
  expect(validateEdit).not.toHaveBeenCalled();
  expect(tracker.activeCount).toBe(0);
});
it.each(['new', 'edit'])('retains real %s durable Book/cover commit through suspended terminal handling', async (mode) => {
  const gate = deferred();
  const committed = deferred();
  const service = app.locals.managedImageService;
  const rollback = vi.spyOn(service, 'rollbackCommitted');
  const compensate = vi.spyOn(service, 'compensate');
  const id = mode === 'edit' ? app.locals.bookService.createBook({ title: 'Before' }).id : null;
  const { createBookWithUploadedCover } = await import('../src/middleware/book-create-multipart.js');
  const { updateBookWithUploadedCover } = await import('../src/middleware/book-edit-multipart.js');
  const work = admitted(async (req, res) => {
    const deps = { bookService: app.locals.bookService, managedImageService: service };
    const result = mode === 'new' ? await createBookWithUploadedCover(req, res, deps, bytes)
      : await updateBookWithUploadedCover(req, res, deps, id, bytes);
    committed.resolve(result);
    await gate.promise;
  });
  await committed.promise;
  const snapshot = db.prepare('SELECT * FROM book_primary_images').all();
  expect(snapshot).toHaveLength(1);
  const h = shutdownHarness();
  const stopping = h.shutdown();
  await h.finishNetwork();
  expect(db.open).toBe(true);
  expect(tracker.activeCount).toBe(1);
  expect(db.prepare('SELECT * FROM book_primary_images').all()).toEqual(snapshot);
  gate.resolve();
  await work.result;
  await stopping;
  expect(rollback).not.toHaveBeenCalled();
  expect(compensate).not.toHaveBeenCalled();
});
it.each([false, true])('waits for disconnected cleanup (recovery required=%s)', async (recovery) => {
  const gate = deferred();
  const cleaning = deferred();
  const service = app.locals.managedImageService;
  const compensate = service.compensate;
  vi.spyOn(service, 'compensate').mockImplementation(async (...args) => {
    cleaning.resolve();
    await gate.promise;
    expect(db.open).toBe(true);
    if (recovery) throw new Error('retained recovery source');
    return compensate(...args);
  });
  const { createBookWithUploadedCover } = await import('../src/middleware/book-create-multipart.js');
  const ingest = service.createCommittedImage;
  vi.spyOn(service, 'createCommittedImage').mockImplementation(async (...args) => {
    const result = await ingest(...args);
    work.res.emit('close');
    return result;
  });
  const work = admitted((req, res) => createBookWithUploadedCover(req, res,
    { bookService: app.locals.bookService, managedImageService: service }, bytes));
  const outcome = work.result.catch((err) => err);
  await cleaning.promise;
  const files = () => fs.readdirSync(path.join(tmp, 'assets'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const retained = files();
  expect(retained.length).toBeGreaterThan(0);
  const h = shutdownHarness();
  const stopping = h.shutdown();
  await h.finishNetwork();
  expect(db.open).toBe(true);
  expect(tracker.activeCount).toBe(1);
  gate.resolve();
  const result = await outcome;
  if (recovery) expect(result.code).toBe('RECOVERY_REQUIRED');
  else expect(result).toBeNull();
  await stopping;
  expect(files()).toEqual(recovery ? retained : []);
  expect(h.exit).toHaveBeenCalledWith(0);
});
