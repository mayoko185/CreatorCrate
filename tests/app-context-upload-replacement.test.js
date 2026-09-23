import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createApplicationContext } from '../src/app-context.js';
import { openDatabase, runMigrations } from '../src/db.js';
import { createBackupService, BackupError } from '../src/services/backup-service.js';
import { managedUploadTracker as tracker } from '../src/services/managed-upload-tracker.js';
import { parseBookCoverMultipart } from '../src/services/book-cover-multipart.js';
import { parseBookImportUpload } from '../src/middleware/book-import-multipart.js';
import { createBookImportOrchestrationService } from '../src/services/book-import-orchestration-service.js';
import { createManagedImageService } from '../src/services/managed-image-service.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';

vi.mock('../src/services/book-cover-multipart.js', async (original) => {
  const actual = await original();
  return { ...actual, parseBookCoverMultipart: vi.fn(actual.parseBookCoverMultipart) };
});
vi.mock('../src/middleware/book-import-multipart.js', async (original) => {
  const actual = await original();
  return { ...actual, parseBookImportUpload: vi.fn(actual.parseBookImportUpload) };
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

describe('WP7D3B2 replacement and restore ownership', () => {
  let tmp, db, context, backup, owner, candidate;
  let restoreOverride, adoptOverride, failBuild, connections;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp7d3b2-'));
    const databasePath = path.join(tmp, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, migrationsDir);
    backup = createBackupService({ appDataRoot: tmp, databasePath, migrationsDir });
    connections = new Set([db]);
    restoreOverride = null;
    adoptOverride = null;
    failBuild = false;
    const service = { ...backup, restoreBackup: (...args) => (restoreOverride || backup.restoreBackup)(...args) };
    context = createApplicationContext({ appName: 'CreatorCrate', appOpts: {
      appDataRoot: tmp, databasePath, migrationsDir, backupService: service,
    } }, db, (deps, opts) => {
      if (failBuild) throw new Error('injected reconstruction failure');
      return createApp(deps, { ...opts,
        beginReplacement: () => (owner = opts.beginReplacement()),
        onDatabaseReplaced: async (...args) => {
          if (adoptOverride) await adoptOverride(...args);
          return opts.onDatabaseReplaced(...args);
        },
      });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of new Set([...connections, context.db, candidate])) {
      if (connection?.open) connection.close();
    }
    // Fatal scenarios deliberately retain the owner until this isolated graph is destroyed.
    owner?.release();
    owner = null;
    candidate = null;
    expect(tracker.activeCount).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const restore = (filename = 'missing.sqlite') => request(context.handleRequest)
    .post(`/settings/backups/${filename}/restore`);
  const newDb = () => {
    candidate = openDatabase(':memory:');
    connections.add(candidate);
    runMigrations(candidate, migrationsDir);
    return candidate;
  };
  const assertAdmissionOpen = () => {
    const upload = tracker.begin();
    expect(upload).not.toBeNull();
    upload.complete();
  };

  async function coverArchive(count) {
    const sourceRoot = path.join(tmp, 'source');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(path.join(sourceRoot, 'exports'));
    const sourceDb = openDatabase(path.join(sourceRoot, 'source.db'));
    connections.add(sourceDb);
    runMigrations(sourceDb, migrationsDir);
    const sourceApp = createApp({ appName: 'CreatorCrate', db: sourceDb }, {
      appDataRoot: sourceRoot, bookExportTempRoot: path.join(sourceRoot, 'exports'),
    });
    const ids = [];
    for (let index = 0; index < count; index++) {
      const book = sourceApp.locals.bookService.createBook({ title: `Cover import ${index}` });
      const bytes = await sharp({
        create: { width: 12, height: 12, channels: 3, background: index ? 'blue' : 'red' },
      }).png().toBuffer();
      const { record } = await sourceApp.locals.managedImageService.createCommittedImage({
        bytes, namespace: 'book-covers',
      });
      sourceApp.locals.bookPrimaryImageService.setManagedPrimaryImage(book.id, record.id);
      ids.push(book.id);
    }
    const exported = await sourceApp.locals.bookExportService.createExport(ids);
    try { return fs.readFileSync(exported.filePath); }
    finally { exported.cleanup(); }
  }

  function authenticatedImportContext(wrapImages) {
    context = createApplicationContext({ appName: 'CreatorCrate', appOpts: {
      appDataRoot: tmp, databasePath: db.name, migrationsDir, backupService: backup,
      authConfig: AUTH_CONFIG,
    } }, db, (deps, opts) => {
      const images = createManagedImageService({
        managedAssetRoot: path.join(tmp, 'assets'),
        managedAssetRepository: createManagedAssetRepository(deps.db),
      });
      return createApp(deps, {
        ...opts,
        bookImportOrchestrationService: createBookImportOrchestrationService({
          db: deps.db,
          managedImageService: wrapImages(images),
          applicationLogger: opts.applicationLogger,
        }),
      });
    });
  }

  async function importArchive(agent, csrfToken, archive) {
    return agent.post('/notes/books/import').field('_csrf', csrfToken)
      .attach('archive', archive, 'books.zip').set('Accept', 'application/json');
  }

  it('keeps the real import graph alive through cover preparation and a disconnected request', async () => {
    const archive = await coverArchive(1);
    const saved = await backup.createBackup(db);
    const entered = deferred(), gate = deferred();
    authenticatedImportContext((images) => ({
      ...images,
      async createCommittedImage(input) {
        entered.resolve();
        await gate.promise;
        return images.createCommittedImage(input);
      },
    }));
    const { agent, csrfToken } = await authenticate(context.handleRequest);
    const originalParser = parseBookImportUpload.getMockImplementation();
    let importRequest;
    parseBookImportUpload.mockImplementationOnce((req, res, next) => {
      importRequest = req;
      return originalParser(req, res, next);
    });
    const pending = importArchive(agent, csrfToken, archive).then((response) => response);
    await entered.promise;
    try {
      importRequest.emit('aborted');
      expect(importRequest.bookUploadLifetime.operation.signal.aborted).toBe(true);
      const refused = await agent.post(`/settings/backups/${saved.filename}/restore`)
        .type('form').send({ _csrf: csrfToken }).expect(302);
      expect(refused.headers.location).toBe('/settings/backups?notice=restore_conflict');
      expect(() => context.replaceDatabase(newDb())).toThrow();
      expect(context.db).toBe(db);
      expect(db.open).toBe(true);
      expect(db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(0);
    } finally { gate.resolve(); }
    const imported = await pending;
    expect(imported.status).toBe(200);
    expect(imported.body.books[0].coverOutcome.kind).toBe('managed');
    expect(db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Cover import 0']);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(1);
    const admitted = await agent.post(`/settings/backups/${saved.filename}/restore`)
      .type('form').send({ _csrf: csrfToken }).expect(302);
    expect(admitted.headers.location).toBe('/settings/backups?notice=restore_success');
    expect(db.open).toBe(false);
    expect(context.db.open).toBe(true);
    expect(context.db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(0);
  });

  it('retains import ownership through synchronous graph-dependent cover compensation', async () => {
    const archive = await coverArchive(2);
    const saved = await backup.createBackup(db);
    const entered = deferred(), gate = deferred();
    let preparations = 0;
    let rollbackObserved = false;
    let compensationObserved = false;
    authenticatedImportContext((images) => ({
      ...images,
      async createCommittedImage(input) {
        preparations++;
        if (preparations === 2) {
          entered.resolve();
          await gate.promise;
          throw new Error('Injected second cover preparation failure');
        }
        return images.createCommittedImage(input);
      },
      rollbackCommitted(token) {
        expect(db.open).toBe(true);
        expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(1);
        expect(() => context.beginReplacement()).toThrow();
        rollbackObserved = true;
        return images.rollbackCommitted(token);
      },
      compensate(token) {
        expect(db.open).toBe(true);
        expect(() => context.beginReplacement()).toThrow();
        compensationObserved = true;
        return images.compensate(token);
      },
    }));
    const { agent, csrfToken } = await authenticate(context.handleRequest);
    const pending = importArchive(agent, csrfToken, archive).then((response) => response);
    await entered.promise;
    try {
      const refused = await agent.post(`/settings/backups/${saved.filename}/restore`)
        .type('form').send({ _csrf: csrfToken }).expect(302);
      expect(refused.headers.location).toBe('/settings/backups?notice=restore_conflict');
      expect(context.db).toBe(db);
      expect(db.open).toBe(true);
    } finally { gate.resolve(); }
    expect((await pending).status).toBe(500);
    expect(rollbackObserved).toBe(true);
    expect(compensationObserved).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(0);
    const coverRoot = path.join(tmp, 'assets', 'book-covers');
    expect(fs.existsSync(coverRoot) ? fs.readdirSync(coverRoot) : []).toEqual([]);
    context.replaceDatabase(newDb());
    expect(context.db).toBe(candidate);
    expect(candidate.open).toBe(true);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'combines processing=%s and upload=%s without disturbing either', async (processing, upload) => {
      const reservation = processing ? context.processingJobService.reserveSubmission(1) : null;
      const lease = upload ? tracker.begin() : null;
      const originalApp = context.app;
      try {
        const replacement = newDb();
        if (processing || upload) {
          expect(() => context.replaceDatabase(replacement)).toThrow();
          expect(replacement.open).toBe(false);
          expect(context.app).toBe(originalApp);
          expect(context.db).toBe(db);
          expect(db.open).toBe(true);
          expect(tracker.activeCount).toBe(upload ? 1 : 0);
          expect(lease?.signal.aborted || false).toBe(false);
          expect(context.app.locals.maintenanceState.active).toBe(false);
          const response = await restore();
          expect(response.headers.location).toBe('/settings/backups?notice=restore_conflict');
        } else {
          context.replaceDatabase(replacement);
          expect(context.db).toBe(replacement);
          expect(context.app.locals.managedUploadTracker).toBe(originalApp.locals.managedUploadTracker);
          assertAdmissionOpen();
        }
      } finally {
        lease?.complete();
        reservation?.release();
      }
      context.replaceDatabase(newDb());
      expect(context.app.locals.managedUploadTracker).toBe(tracker);
      assertAdmissionOpen();
    },
  );

  it.each(['/notes/books', '/notes/books/1'])('already-parsing %s refuses restore and direct replacement, then finishes normally', async (route) => {
    context.app.locals.bookService.createBook({ title: 'Original' });
    const entered = deferred();
    const gate = deferred();
    const original = parseBookCoverMultipart.getMockImplementation();
    parseBookCoverMultipart.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
    const pending = request(context.handleRequest).post(route).field('title', 'Uploaded')
      .field('expectedCoverKind', 'none').attach('cover', bytes, 'cover.png').then((r) => r);
    await entered.promise;
    try {
      expect(tracker.activeCount).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(0);
      expect((await restore()).headers.location).toBe('/settings/backups?notice=restore_conflict');
      expect(() => context.replaceDatabase(newDb())).toThrow();
      expect(db.open).toBe(true);
      expect(context.db).toBe(db);
      expect(tracker.activeCount).toBe(1);
    } finally { gate.resolve(); }
    expect((await pending).status).toBe(302);
    expect(tracker.activeCount).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(1);
    context.replaceDatabase(newDb());
    assertAdmissionOpen();
  });

  it('holds maintenance during service work and between real restore completion and delayed adoption', async () => {
    const saved = await backup.createBackup(db);
    const entered = deferred(), serviceGate = deferred(), produced = deferred(), adoptionGate = deferred();
    const originalApp = context.app;
    restoreOverride = async (...args) => {
      entered.resolve();
      await serviceGate.promise;
      const result = await backup.restoreBackup(...args);
      candidate = result.db;
      return result;
    };
    adoptOverride = async () => { produced.resolve(); await adoptionGate.promise; };
    const pending = restore(saved.filename).then((r) => r);
    await entered.promise;
    const refused = async () => {
      parseBookCoverMultipart.mockClear();
      for (const route of ['/notes/books', '/notes/books/1']) {
        await request(context.handleRequest).post(route).field('title', 'Blocked').expect(503);
      }
      expect(parseBookCoverMultipart).not.toHaveBeenCalled();
      expect(tracker.activeCount).toBe(0);
    };
    try {
      expect(db.open).toBe(true);
      await refused();
      serviceGate.resolve();
      await produced.promise;
      expect(db.open).toBe(false);
      expect(backup.isRestoreInProgress()).toBe(false);
      expect(context.app).toBe(originalApp);
      await refused();
    } finally { serviceGate.resolve(); adoptionGate.resolve(); }
    expect((await pending).headers.location).toBe('/settings/backups?notice=restore_success');
    expect(context.db).toBe(candidate);
    expect(context.app.locals.managedUploadTracker).toBe(tracker);
    expect(originalApp.locals.managedUploadTracker).toBe(tracker);
    expect(candidate.prepare("SELECT count(*) AS n FROM application_logs WHERE event = 'backup.restored'").get().n).toBe(1);
    assertAdmissionOpen();
  });

  it('validation failure leaves the original graph usable and reopens admission', async () => {
    expect((await restore()).headers.location).toBe('/settings/backups?notice=restore_failed');
    expect(context.db).toBe(db);
    expect(db.open).toBe(true);
    assertAdmissionOpen();
  });

  it('adopts a recovered usable database before releasing maintenance', async () => {
    const entered = deferred(), gate = deferred();
    restoreOverride = async (_filename, connection, capability) => {
      tracker.assertMaintenanceOwner(capability, connection);
      connection.close();
      throw new BackupError('Recovered', { db: newDb() });
    };
    adoptOverride = async () => { entered.resolve(); await gate.promise; };
    const pending = restore().then((r) => r);
    await entered.promise;
    try {
      expect(context.db).toBe(db);
      expect(db.open).toBe(false);
      expect(tracker.begin()).toBeNull();
    } finally { gate.resolve(); }
    expect((await pending).headers.location).toBe('/settings/backups?notice=restore_failed');
    expect(context.db).toBe(candidate);
    expect(candidate.open).toBe(true);
    assertAdmissionOpen();
  });

  it.each(['no recovery', 'adoption failure'])('fails closed after retirement: %s', async (mode) => {
    restoreOverride = async (_filename, connection, capability) => {
      tracker.assertMaintenanceOwner(capability, connection);
      connection.close();
      if (mode === 'no recovery') throw new Error('injected fatal restore failure');
      failBuild = true;
      return { db: newDb() };
    };
    await restore().expect(500);
    expect(db.open).toBe(false);
    expect(context.db).toBe(db);
    expect(context.app.locals.managedUploadTracker).toBe(tracker);
    expect(tracker.begin()).toBeNull();
    await request(context.handleRequest).post('/notes/books').field('title', 'Blocked').expect(503);
    if (candidate) expect(candidate.open).toBe(false);
  });

  it('failed direct rebuild cleans the candidate but retains the usable graph and tracker', () => {
    const originalApp = context.app;
    failBuild = true;
    expect(() => context.replaceDatabase(newDb())).toThrow('injected reconstruction failure');
    expect(candidate.open).toBe(false);
    expect(context.app).toBe(originalApp);
    expect(db.open).toBe(true);
    expect(context.app.locals.managedUploadTracker).toBe(tracker);
    assertAdmissionOpen();
  });

  it('requires an authentic owner immediately before live checkpoint/close', async () => {
    const saved = await backup.createBackup(db);
    const checkpoint = vi.spyOn(db, 'pragma');
    await expect(backup.restoreBackup(saved.filename, db)).rejects.toThrow(/ownership/);
    await expect(backup.restoreBackup(saved.filename, db, { assertCanRetire() {} })).rejects.toThrow(/ownership/);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(db.open).toBe(true);
  });

  it('delayed restore cannot retire a no-longer-current database or release the next owner', async () => {
    const saved = await backup.createBackup(db);
    const stale = context.beginReplacement();
    const pending = backup.restoreBackup(saved.filename, db, stale);
    context.replaceDatabase(newDb(), stale);
    expect(tracker.begin()).toBeNull();
    await expect(pending).rejects.toThrow(/not current/);
    expect(db.open).toBe(true);
    stale.release();
    owner = context.beginReplacement();
    expect(stale.release()).toBe(false);
    expect(tracker.begin()).toBeNull();
    owner.release();
    assertAdmissionOpen();
  });

  it('stale owner cannot adopt or close the current connection', () => {
    const stale = context.beginReplacement();
    stale.release();
    owner = context.beginReplacement();
    expect(() => context.replaceDatabase(db, stale)).toThrow(/not current/);
    expect(db.open).toBe(true);
    expect(context.db).toBe(db);
    expect(tracker.begin()).toBeNull();
  });
  it.each([false, true])('direct auth replacement refuses an upload (processing=%s) without changing the graph', (processing) => {
    const app = context.app;
    const reservation = processing ? context.processingJobService.reserveSubmission(1) : null;
    const lease = tracker.begin();
    try {
      expect(() => context.replaceAuthConfig(null)).toThrow();
      expect(context.app).toBe(app);
      expect(db.open).toBe(true);
      expect(tracker.activeCount).toBe(1);
      expect(lease.signal.aborted).toBe(false);
      expect(app.locals.maintenanceState.active).toBe(false);
    } finally { lease.complete(); reservation?.release(); }
    context.replaceAuthConfig(null);
    expect(context.app).not.toBe(app);
    expect(context.app.locals.managedUploadTracker).toBe(tracker);
    assertAdmissionOpen();
  });

  it('checks processing only after admission is synchronously closed', () => {
    const check = vi.spyOn(context.processingJobService, 'hasActiveJobs').mockImplementation(() => {
      expect(tracker.begin()).toBeNull();
      return true;
    });
    expect(() => context.beginReplacement()).toThrow(/processing jobs/);
    expect(check).toHaveBeenCalledOnce();
    assertAdmissionOpen();
  });

  it('cannot use a capability from another graph even when the connection is shared', () => {
    const other = createApplicationContext({ appName: 'Other' }, db, () => ({}));
    owner = context.beginReplacement();
    expect(() => other.replaceAuthConfig(null, owner)).toThrow(/not current/);
    expect(db.open).toBe(true);
    expect(tracker.begin()).toBeNull();
  });
});
