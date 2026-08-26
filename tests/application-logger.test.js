import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createApplicationContext } from '../src/app-context.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function record(overrides = {}) {
  return {
    kind: 'diagnostic',
    subsystem: 'test',
    event: 'test.event',
    message: 'test message',
    ...overrides,
  };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('application logger', () => {
  it('validates level and kind while persisting info and above by default', () => {
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository, now: () => 100 });

    expect(logger.debug(record())).toBe(false);
    expect(logger.info(record({ kind: 'activity' }))).toBe(true);
    expect(logger.warn(record())).toBe(true);
    expect(logger.error(record())).toBe(true);
    expect(logger.fatal(record())).toBe(true);
    expect(logger.log(record({ level: 'notice' }))).toBe(false);
    expect(logger.info(record({ kind: 'other' }))).toBe(false);
    expect(repository.insert).toHaveBeenCalledTimes(4);
    expect(repository.insert.mock.calls[0][0]).toMatchObject({
      occurredAtMs: 100,
      level: 'info',
      kind: 'activity',
    });
  });

  it('persists debug only when configured', () => {
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository, persistDebug: true });

    expect(logger.debug(record())).toBe(true);
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ level: 'debug' }));
  });

  it('redacts sensitive context and errors without persisting stacks or absolute paths', () => {
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository });
    const error = Object.assign(new Error('Failed at C:\\CreatorCrate\\secret.txt'), { code: 'EFAIL' });

    logger.error(record({
      context: {
        password: 'nope',
        requestBody: { unsafe: true },
        nested: { path: '/srv/creatorcrate/project' },
        clean: 'ok\u0000still ok',
      },
      error,
    }));

    const persisted = repository.insert.mock.calls[0][0];
    expect(persisted.context).toEqual({
      password: '[redacted]',
      requestBody: '[redacted]',
      nested: { path: '[redacted path]' },
      clean: 'ok still ok',
      error: { name: 'Error', code: 'EFAIL', message: '[redacted path]' },
    });
    expect(persisted.context.error).not.toHaveProperty('stack');
  });

  it('preserves only a positive safe numeric watermarkId while redacting every other Watermark value', () => {
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository });

    logger.info(record({
      context: {
        watermarkId: 17,
        watermarkPath: '/srv/creatorcrate/watermark.png',
        watermarkData: 'binary-content',
        watermarkOptions: { opacity: 0.5 },
        watermark: 'arbitrary payload',
      },
    }));

    expect(repository.insert.mock.calls[0][0].context).toEqual({
      watermarkId: 17,
      watermarkPath: '[redacted]',
      watermarkData: '[redacted]',
      watermarkOptions: '[redacted]',
      watermark: '[redacted]',
    });

    for (const watermarkId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '17', { id: 17 }, [17]]) {
      logger.info(record({ context: { watermarkId } }));
    }

    for (const [persisted] of repository.insert.mock.calls.slice(1)) {
      expect(persisted.context).toEqual({ watermarkId: '[redacted]' });
    }
  });

  it('isolates repository failures and emits one non-recursive console fallback per failure message', () => {
    const repository = {
      insert: vi.fn(() => { throw new Error('database unavailable'); }),
      prune: vi.fn(),
    };
    const consoleSink = { error: vi.fn(() => { throw new Error('console unavailable'); }) };
    const logger = createApplicationLogger({ repository, console: consoleSink });

    expect(() => logger.info(record())).not.toThrow();
    expect(() => logger.info(record())).not.toThrow();
    expect(repository.insert).toHaveBeenCalledTimes(2);
    expect(consoleSink.error).toHaveBeenCalledTimes(1);
  });

  it('prunes at startup and never more than once per day', () => {
    let nowMs = 1_000;
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository, now: () => nowMs });

    expect(logger.prune()).toBe(true);
    expect(logger.prune()).toBe(false);
    nowMs += 24 * 60 * 60 * 1000 - 1;
    expect(logger.prune()).toBe(false);
    nowMs += 1;
    expect(logger.prune()).toBe(true);
    expect(repository.prune).toHaveBeenCalledTimes(2);
  });

  it('opportunistically prunes after successful persisted logs on the existing daily schedule', () => {
    let nowMs = 1_000;
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository, now: () => nowMs });

    expect(logger.prune()).toBe(true);
    expect(logger.debug(record())).toBe(false);
    expect(repository.prune).toHaveBeenCalledTimes(1);

    nowMs += 24 * 60 * 60 * 1000 - 1;
    expect(logger.info(record())).toBe(true);
    expect(repository.prune).toHaveBeenCalledTimes(1);

    nowMs += 1;
    expect(logger.debug(record())).toBe(false);
    expect(repository.prune).toHaveBeenCalledTimes(1);
    expect(logger.info(record())).toBe(true);
    expect(repository.prune).toHaveBeenCalledTimes(2);
    expect(logger.warn(record())).toBe(true);
    expect(logger.error(record())).toBe(true);
    expect(repository.prune).toHaveBeenCalledTimes(2);

    nowMs += 24 * 60 * 60 * 1000;
    expect(logger.info(record())).toBe(true);
    expect(repository.prune).toHaveBeenCalledTimes(3);
  });

  it('allows a later eligible persisted log to prune after a logging failure', () => {
    let nowMs = 1_000;
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const logger = createApplicationLogger({ repository, now: () => nowMs });

    expect(logger.prune()).toBe(true);
    nowMs += 24 * 60 * 60 * 1000;
    repository.insert.mockImplementationOnce(() => { throw new Error('database unavailable'); });
    expect(logger.info(record())).toBe(false);
    expect(repository.prune).toHaveBeenCalledTimes(1);

    expect(logger.info(record())).toBe(true);
    expect(repository.prune).toHaveBeenCalledTimes(2);
  });

  it('isolates eligible runtime prune failures without recursive logging', () => {
    let nowMs = 1_000;
    const repository = { insert: vi.fn(), prune: vi.fn() };
    const consoleSink = { error: vi.fn() };
    const logger = createApplicationLogger({ repository, console: consoleSink, now: () => nowMs });

    expect(logger.prune()).toBe(true);
    repository.prune.mockImplementation(() => { throw new Error('retention unavailable'); });
    nowMs += 24 * 60 * 60 * 1000;

    expect(() => logger.info(record())).not.toThrow();
    expect(repository.insert).toHaveBeenCalledOnce();
    expect(repository.prune).toHaveBeenCalledTimes(2);
    expect(consoleSink.error).toHaveBeenCalledOnce();
  });
});

describe('application logger database lifecycle', () => {
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps one logger instance while rebinding writes to the replacement database', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-application-logger-'));
    temporaryDirectories.push(directory);
    const initialDb = openDatabase(path.join(directory, 'initial.db'));
    const replacementDb = openDatabase(path.join(directory, 'replacement.db'));
    runMigrations(initialDb, MIGRATIONS_DIR);
    runMigrations(replacementDb, MIGRATIONS_DIR);
    const appContext = createApplicationContext({ appName: 'CreatorCrate', appOpts: {} }, initialDb);

    try {
      const logger = appContext.app.locals.applicationLogger;
      const initialRepository = appContext.app.locals.applicationLogRepository;
      expect(logger).toBeTruthy();
      expect(initialRepository).toBeTruthy();
      expect(logger.info(record({ event: 'before.replace' }))).toBe(true);
      expect(initialDb.prepare('SELECT COUNT(*) AS count FROM application_logs').get().count).toBe(1);

      appContext.replaceDatabase(replacementDb);
      expect(appContext.app.locals.applicationLogger).toBe(logger);
      expect(appContext.app.locals.applicationLogRepository).not.toBe(initialRepository);
      expect(logger.getRepository()).toBe(appContext.app.locals.applicationLogRepository);
      expect(logger.info(record({ event: 'after.replace' }))).toBe(true);
      expect(replacementDb.prepare('SELECT event FROM application_logs').all()).toEqual([{ event: 'after.replace' }]);
      expect(initialDb.prepare('SELECT event FROM application_logs').all()).toEqual([{ event: 'before.replace' }]);
    } finally {
      closeDatabase(initialDb);
      closeDatabase(replacementDb);
    }
  });

  it('keeps successful same-database auth rebuilds on one repository and one prune window', () => {
    let nowMs = 1_000;
    const initialRepository = { insert: vi.fn(), prune: vi.fn() };
    const applicationLogger = createApplicationLogger({ repository: initialRepository, now: () => nowMs });
    const initialDb = { id: 'initial' };
    const appFactory = ({ db }, opts) => {
      expect(db).toBe(initialDb);
      expect(opts.applicationLogRepository).toBe(initialRepository);
      opts.applicationLogger.rebindRepository(opts.applicationLogRepository);
      opts.applicationLogger.prune();
      return {
        applicationLogger: opts.applicationLogger,
        applicationLogRepository: opts.applicationLogRepository,
        db,
      };
    };
    const appContext = createApplicationContext(
      { appName: 'CreatorCrate', appOpts: { applicationLogger, applicationLogRepository: initialRepository } },
      initialDb,
      appFactory,
    );
    const logger = appContext.app.applicationLogger;
    const repository = appContext.app.applicationLogRepository;

    expect(initialRepository.prune).toHaveBeenCalledOnce();

    appContext.replaceAuthConfig({ enabled: true });

    expect(appContext.app.applicationLogger).toBe(logger);
    expect(appContext.app.applicationLogRepository).toBe(repository);
    expect(applicationLogger.getRepository()).toBe(repository);
    expect(initialRepository.prune).toHaveBeenCalledOnce();
    expect(applicationLogger.info(record({ event: 'after.same-db.rebuild' }))).toBe(true);
    expect(initialRepository.prune).toHaveBeenCalledOnce();

    nowMs += 24 * 60 * 60 * 1000;
    expect(applicationLogger.info(record({ event: 'after.same-db.eligible' }))).toBe(true);
    expect(initialRepository.prune).toHaveBeenCalledTimes(2);
  });

  it('restores the same repository and retention eligibility when a same-database auth rebuild fails', () => {
    let nowMs = 1_000;
    const initialRepository = { insert: vi.fn(), prune: vi.fn() };
    const applicationLogger = createApplicationLogger({ repository: initialRepository, now: () => nowMs });
    const initialDb = { id: 'initial' };
    const appFactory = ({ db }, opts) => {
      opts.applicationLogger.rebindRepository(opts.applicationLogRepository);
      opts.applicationLogger.prune();
      if (opts.authConfig?.fail) {
        throw new Error('same-database candidate app construction failed');
      }
      return {
        applicationLogger: opts.applicationLogger,
        applicationLogRepository: opts.applicationLogRepository,
        db,
      };
    };
    const appContext = createApplicationContext(
      { appName: 'CreatorCrate', appOpts: { applicationLogger, applicationLogRepository: initialRepository } },
      initialDb,
      appFactory,
    );
    const originalApp = appContext.app;

    expect(initialRepository.prune).toHaveBeenCalledOnce();
    expect(() => appContext.replaceAuthConfig({ fail: true })).toThrow('same-database candidate app construction failed');
    expect(appContext.app).toBe(originalApp);
    expect(applicationLogger.getRepository()).toBe(initialRepository);
    expect(initialRepository.prune).toHaveBeenCalledOnce();
    expect(applicationLogger.info(record({ event: 'after.failed.same-db.rebuild' }))).toBe(true);
    expect(initialRepository.prune).toHaveBeenCalledOnce();

    nowMs += 24 * 60 * 60 * 1000;
    expect(applicationLogger.info(record({ event: 'after.failed.same-db.eligible' }))).toBe(true);
    expect(initialRepository.prune).toHaveBeenCalledTimes(2);
  });


  it('restores the shared logger repository and its prune eligibility when candidate construction fails', () => {
    let nowMs = 1_000;
    const initialRepository = { insert: vi.fn(), prune: vi.fn() };
    const candidateRepository = { insert: vi.fn(), prune: vi.fn() };
    const applicationLogger = createApplicationLogger({ repository: initialRepository, now: () => nowMs });
    const initialDb = { id: 'initial' };
    const candidateDb = { close: vi.fn(), id: 'candidate' };
    const appFactory = ({ db }, opts) => {
      if (db === candidateDb) {
        opts.applicationLogger.rebindRepository(candidateRepository);
        opts.applicationLogger.prune();
        throw new Error('candidate app construction failed');
      }
      return { db };
    };
    const appContext = createApplicationContext(
      { appName: 'CreatorCrate', appOpts: { applicationLogger } },
      initialDb,
      appFactory,
    );

    expect(applicationLogger.prune()).toBe(true);
    nowMs += 24 * 60 * 60 * 1000;
    expect(() => appContext.replaceDatabase(candidateDb)).toThrow('candidate app construction failed');
    expect(candidateRepository.prune).toHaveBeenCalledOnce();
    expect(candidateDb.close).toHaveBeenCalledOnce();
    expect(applicationLogger.getRepository()).toBe(initialRepository);
    expect(applicationLogger.info(record({ event: 'after.failed.replace' }))).toBe(true);
    expect(initialRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ event: 'after.failed.replace' }));
    expect(initialRepository.prune).toHaveBeenCalledTimes(2);
    expect(candidateRepository.insert).not.toHaveBeenCalled();
  });

  it('keeps successful replacement pruning scoped to the replacement repository', () => {
    let nowMs = 1_000;
    const initialRepository = { insert: vi.fn(), prune: vi.fn() };
    const replacementRepository = { insert: vi.fn(), prune: vi.fn() };
    const applicationLogger = createApplicationLogger({ repository: initialRepository, now: () => nowMs });
    const initialDb = { id: 'initial' };
    const replacementDb = { close: vi.fn(), id: 'replacement' };
    const appFactory = ({ db }, opts) => {
      const repository = db === replacementDb ? replacementRepository : initialRepository;
      opts.applicationLogger.rebindRepository(repository);
      opts.applicationLogger.prune();
      return { applicationLogger: opts.applicationLogger, db };
    };
    const appContext = createApplicationContext(
      { appName: 'CreatorCrate', appOpts: { applicationLogger } },
      initialDb,
      appFactory,
    );
    const loggerBeforeReplacement = appContext.app.applicationLogger;

    appContext.replaceDatabase(replacementDb);

    expect(appContext.app.applicationLogger).toBe(loggerBeforeReplacement);
    expect(applicationLogger.getRepository()).toBe(replacementRepository);
    expect(initialRepository.prune).toHaveBeenCalledOnce();
    expect(replacementRepository.prune).toHaveBeenCalledOnce();
    expect(applicationLogger.info(record({ event: 'after.successful.replace.1' }))).toBe(true);
    expect(applicationLogger.info(record({ event: 'after.successful.replace.2' }))).toBe(true);
    expect(replacementRepository.prune).toHaveBeenCalledOnce();
    expect(initialRepository.insert).not.toHaveBeenCalled();

    nowMs += 24 * 60 * 60 * 1000;
    expect(applicationLogger.info(record({ event: 'after.successful.replace.eligible' }))).toBe(true);
    expect(replacementRepository.prune).toHaveBeenCalledTimes(2);
    expect(initialRepository.prune).toHaveBeenCalledOnce();
  });

  it('keeps processing lifecycle logging on the shared logger across database replacement', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-logger-'));
    temporaryDirectories.push(directory);
    const initialDb = openDatabase(path.join(directory, 'initial.db'));
    const replacementDb = openDatabase(path.join(directory, 'replacement.db'));
    runMigrations(initialDb, MIGRATIONS_DIR);
    runMigrations(replacementDb, MIGRATIONS_DIR);
    const appContext = createApplicationContext({ appName: 'CreatorCrate', appOpts: {} }, initialDb);

    try {
      const firstJobId = appContext.processingJobService.enqueue({
        projectId: 1,
        operation: 'convert',
        assetCount: 1,
        execute: () => ({ changedCount: 1 }),
      });
      await settle();
      expect(initialDb.prepare('SELECT event, correlation_id FROM application_logs ORDER BY id').all()).toEqual([
        { event: 'processing.job.queued', correlation_id: firstJobId },
        { event: 'processing.job.started', correlation_id: firstJobId },
        { event: 'processing.job.succeeded', correlation_id: firstJobId },
      ]);

      appContext.replaceDatabase(replacementDb);
      const secondJobId = appContext.processingJobService.enqueue({
        projectId: 1,
        operation: 'archive',
        assetCount: 2,
        execute: () => ({ changedCount: 2 }),
      });
      await settle();
      expect(replacementDb.prepare('SELECT event, correlation_id FROM application_logs ORDER BY id').all()).toEqual([
        { event: 'processing.job.queued', correlation_id: secondJobId },
        { event: 'processing.job.started', correlation_id: secondJobId },
        { event: 'processing.job.succeeded', correlation_id: secondJobId },
      ]);
    } finally {
      closeDatabase(initialDb);
      closeDatabase(replacementDb);
    }
  });

  it('persists delimiter-aware secret and path redactions through the application log repository', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-application-log-sanitization-'));
    temporaryDirectories.push(directory);
    const db = openDatabase(path.join(directory, 'logs.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const logger = createApplicationLogger({ repository: createApplicationLogRepository(db) });

    try {
      expect(logger.info(record({
        event: 'sanitization.context',
        context: {
          noteOne: "password 'quoted-password-secret'",
          noteTwo: 'API key [bracketed-api-key-secret]',
          noteThree: 'access token (parenthesized-access-token-secret)',
          authorization: 'Authorization: Bearer secret-value',
          assignedValue: 'access_token=another-secret',
          cookie: 'Cookie: session=secret-cookie-value',
          quotedWindowsPath: "open 'C:\\Users\\Andy\\file.png'",
          quotedUnixPath: 'open "/home/user/file.png"',
          windowsPath: 'open <C:\\Users\\Andy\\file.png>',
          unixPath: 'open </home/user/file.png>',
          ordinary: 'Credential validation failed',
        },
      }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.password', error: new Error("password 'error-password-secret'") }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.api-key', error: new Error('API key [error-api-key-secret]') }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.access-token', error: new Error('access token (error-access-token-secret)') }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.quoted-windows', error: new Error("open 'C:\\Users\\Andy\\file.png'") }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.quoted-unix', error: new Error('open "/home/user/file.png"') }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.windows', error: new Error('open <C:\\Users\\Andy\\file.png>') }))).toBe(true);
      expect(logger.error(record({ event: 'sanitization.error.unix', error: new Error('open </home/user/file.png>') }))).toBe(true);

      const context = JSON.parse(db.prepare("SELECT context_json FROM application_logs WHERE event = 'sanitization.context'").get().context_json);
      expect(context).toMatchObject({
        noteOne: '[redacted secret]',
        noteTwo: '[redacted secret]',
        noteThree: '[redacted secret]',
        authorization: '[redacted]',
        assignedValue: '[redacted secret]',
        cookie: '[redacted]',
        quotedWindowsPath: '[redacted path]',
        quotedUnixPath: '[redacted path]',
        windowsPath: '[redacted path]',
        unixPath: '[redacted path]',
        ordinary: 'Credential validation failed',
      });
      for (const event of [
        'sanitization.error.password',
        'sanitization.error.api-key',
        'sanitization.error.access-token',
      ]) {
        const persisted = JSON.parse(db.prepare('SELECT context_json FROM application_logs WHERE event = ?').get(event).context_json);
        expect(persisted.error.message).toBe('[redacted secret]');
      }
      for (const event of [
        'sanitization.error.quoted-windows',
        'sanitization.error.quoted-unix',
        'sanitization.error.windows',
        'sanitization.error.unix',
      ]) {
        const persisted = JSON.parse(db.prepare('SELECT context_json FROM application_logs WHERE event = ?').get(event).context_json);
        expect(persisted.error.message).toBe('[redacted path]');
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('redacts generic auth-bearing text while preserving descriptive auth prose through the application log repository', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-application-log-generic-auth-'));
    temporaryDirectories.push(directory);
    const db = openDatabase(path.join(directory, 'logs.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const logger = createApplicationLogger({ repository: createApplicationLogRepository(db) });

    try {
      expect(logger.info(record({
        event: 'generic-auth.message',
        message: 'token=visible-token-secret',
      }))).toBe(true);
      expect(logger.info(record({
        event: 'generic-auth.context',
        context: {
          detailOne: 'CSRF=visible-csrf-secret',
          detailTwo: 'auth=visible-auth-secret',
        },
      }))).toBe(true);
      expect(logger.error(record({
        event: 'generic-auth.error',
        error: new Error('Authorization: Custom visible-authorization-secret'),
      }))).toBe(true);
      expect(logger.error(record({
        event: 'generic-auth.safe-prose',
        message: 'Authorization failed',
        context: { detail: 'Token validation failed' },
        error: new Error('CSRF validation failed'),
      }))).toBe(true);

      const rows = db.prepare('SELECT event, message, context_json FROM application_logs ORDER BY id').all();
      expect(JSON.stringify(rows)).not.toContain('visible-');
      expect(rows.find((row) => row.event === 'generic-auth.message').message).toBe('[redacted secret]');
      expect(JSON.parse(rows.find((row) => row.event === 'generic-auth.context').context_json)).toMatchObject({
        detailOne: '[redacted secret]',
        detailTwo: '[redacted secret]',
      });
      expect(JSON.parse(rows.find((row) => row.event === 'generic-auth.error').context_json).error.message)
        .toBe('[redacted secret]');
      const safe = rows.find((row) => row.event === 'generic-auth.safe-prose');
      expect(safe.message).toBe('Authorization failed');
      expect(JSON.parse(safe.context_json)).toMatchObject({
        detail: 'Token validation failed',
        error: { message: 'CSRF validation failed' },
      });
    } finally {
      closeDatabase(db);
    }
  });

  it('redacts structurally stack-shaped strings before persisting them through the application log repository', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-application-log-stack-text-'));
    temporaryDirectories.push(directory);
    const db = openDatabase(path.join(directory, 'logs.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const logger = createApplicationLogger({ repository: createApplicationLogRepository(db) });
    const stackText = 'Error: failed\n    at run (relative.js:1:1)';

    try {
      expect(logger.info(record({
        event: 'stack-text.message',
        message: stackText,
      }))).toBe(true);
      expect(logger.info(record({
        event: 'stack-text.context',
        context: { detail: stackText },
      }))).toBe(true);
      expect(logger.error(record({
        event: 'stack-text.error',
        error: new Error(stackText),
      }))).toBe(true);
      expect(logger.info(record({
        event: 'stack-text.safe-multiline',
        message: 'Deployment note\nat noon',
      }))).toBe(true);

      const rows = db.prepare('SELECT event, message, context_json FROM application_logs ORDER BY id').all();
      expect(JSON.stringify(rows)).not.toContain('relative.js:1:1');
      expect(rows.find((row) => row.event === 'stack-text.message').message).toBe('[redacted stack trace]');
      expect(JSON.parse(rows.find((row) => row.event === 'stack-text.context').context_json).detail)
        .toBe('[redacted stack trace]');
      expect(JSON.parse(rows.find((row) => row.event === 'stack-text.error').context_json).error.message)
        .toBe('[redacted stack trace]');
      expect(rows.find((row) => row.event === 'stack-text.safe-multiline').message)
        .toBe('Deployment note at noon');
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces one shared traversal budget across nested arrays and objects', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-application-log-entry-budget-'));
    temporaryDirectories.push(directory);
    const db = openDatabase(path.join(directory, 'logs.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const logger = createApplicationLogger({ repository: createApplicationLogRepository(db) });
    const branchingArrays = Array.from(
      { length: 10 },
      (_, outer) => Array.from(
        { length: 10 },
        (_, middle) => Array.from({ length: 10 }, (_, inner) => `leaf-${outer}-${middle}-${inner}`),
      ),
    );

    try {
      expect(logger.info(record({
        event: 'sanitization.entry-budget',
        context: {
          smallArray: ['first', 'second'],
          mixed: [{ values: branchingArrays }],
        },
      }))).toBe(true);

      const context = JSON.parse(db.prepare("SELECT context_json FROM application_logs WHERE event = 'sanitization.entry-budget'").get().context_json);
      const serialized = JSON.stringify(context);
      expect(context.smallArray).toEqual(['first', 'second']);
      expect(serialized).toContain('[truncated]');
      expect((serialized.match(/leaf-/g) || []).length).toBeLessThanOrEqual(100);
    } finally {
      closeDatabase(db);
    }
  });
});
