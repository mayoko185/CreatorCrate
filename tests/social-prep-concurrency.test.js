import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { createReleaseService } from '../src/services/release-service.js';
import { createSocialPrepCapabilityService } from '../src/services/social-prep-capability.js';
import { createSocialPrepService } from '../src/services/social-prep-service.js';
import { digestToken, generateMediaToken } from '../src/services/social-prep-tokens.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const POSTED_RACE_WORKER = new URL('./helpers/social-prep-posted-race-worker.js', import.meta.url);
const BARRIER_TIMEOUT_MS = 5_000;

describe('social preparation activation serialization', () => {
  function setup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-'));
    const databasePath = path.join(directory, 'social.db');
    const db = openDatabase(databasePath);
    const rivalDb = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    return { directory, db, rivalDb };
  }

  function dispose({ directory, db, rivalDb }) {
    closeDatabase(rivalDb);
    closeDatabase(db);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  function createService(db) {
    const projectId = Number(db.prepare(`INSERT INTO projects (title, slug, description, notes, status, project_type)
      VALUES ('Project', 'project', '', '', 'ready', 'images')`).run().lastInsertRowid);
    const releaseId = Number(db.prepare(`INSERT INTO releases (project_id, title, description, published_date)
      VALUES (?, 'Release', '', '2030-01-01')`).run(projectId).lastInsertRowid);
    const repository = createSocialPrepRepository(db);
    repository.ensurePlatforms(releaseId, ['x'], { now: new Date('2030-01-01T00:00:00Z') });
    return {
      releaseId,
      repository,
      service: createSocialPrepService({
        db, socialPrepRepository: repository, releaseService: createReleaseService({ db }),
        socialPrepSettingsService: { isEnabled: () => true, getPlatforms: () => ['x'] },
        now: () => new Date('2030-01-01T00:00:00Z'),
      }),
    };
  }

  function createRaceFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-posted-race-'));
    const databasePath = path.join(directory, 'social.db');
    const db = openDatabase(databasePath);
    const oldConfirmationAt = new Date('2030-01-01T00:10:00Z');
    const reprepareAt = new Date('2030-01-01T01:00:00Z');
    let initialized = false;
    try {
      runMigrations(db, MIGRATIONS_DIR);
      const projectId = Number(db.prepare(`INSERT INTO projects (title, slug, description, notes, status, project_type)
        VALUES ('Race Project', 'race-project', '', '', 'ready', 'images')`).run().lastInsertRowid);
      const releaseId = Number(db.prepare(`INSERT INTO releases (project_id, title, description, published_date)
        VALUES (?, 'Race Release', '', '2030-01-01')`).run(projectId).lastInsertRowid);
      const asset = createAssetRepository(db).upsert(projectId, 'image.png', {
        projectId, relativePath: 'image.png', filename: 'image.png', extension: 'png',
        mimeType: 'image/png', sizeBytes: 3, modifiedAt: '2030-01-01T00:00:00Z',
      });
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, 0)')
        .run(releaseId, asset.id, 'primary');

      const repository = createSocialPrepRepository(db);
      const setupService = createSocialPrepService({
        db,
        socialPrepRepository: repository,
        releaseService: createReleaseService({ db }),
        socialPrepSettingsService: { isEnabled: () => true, getPlatforms: () => ['patreon', 'x'] },
        now: () => new Date('2030-01-01T00:00:00Z'),
      });
      setupService.initializePlatformState(releaseId, ['patreon', 'x']);
      const token = generateMediaToken();
      repository.insertSession({
        id: 'S1', releaseId, kind: 'initial', intentHash: 'old-intent',
        expiresAt: new Date('2030-01-01T00:15:00Z'), now: new Date('2030-01-01T00:00:00Z'),
      });
      repository.reassignPlatformsToSession('S1', ['patreon', 'x'], { now: new Date('2030-01-01T00:00:00Z') });
      setupService.redeem({ sessionId: 'S1', intentHash: 'old-intent', mediaTokenHash: digestToken(token) });
      for (const platform of ['patreon', 'x']) {
        setupService.recordPlatformStatus({ releaseId, platform, sessionId: 'S1', status: 'staging' });
        setupService.recordPlatformStatus({ releaseId, platform, sessionId: 'S1', status: 'ready' });
      }
      const confirmationService = createSocialPrepService({
        db,
        socialPrepRepository: repository,
        releaseService: createReleaseService({ db }),
        socialPrepSettingsService: { isEnabled: () => true, getPlatforms: () => ['patreon', 'x'] },
        now: () => oldConfirmationAt,
      });
      const capability = createSocialPrepCapabilityService({ socialPrepRepository: repository, now: () => oldConfirmationAt });
      confirmationService.confirmPlatformPosted({
        sessionId: 'S1', platform: 'patreon',
        authenticate: () => capability.authenticateConfirmation({ authorization: `Bearer ${token}`, sessionId: 'S1' }),
      });
      const patreonBefore = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'patreon');
      initialized = true;
      return {
        directory,
        databasePath,
        releaseId,
        token,
        confirmationAt: oldConfirmationAt.toISOString(),
        reprepareAt: reprepareAt.toISOString(),
        patreonBefore,
      };
    } finally {
      closeDatabase(db);
      if (!initialized) fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  function workerFailure(message) {
    const error = new Error(message.error?.message ?? 'Race worker failed.');
    Object.assign(error, message.error);
    return error;
  }

  function createWorkerClient(workerData) {
    const worker = new Worker(POSTED_RACE_WORKER, { workerData });
    const messages = [];
    const waiters = [];
    let fatalError;
    let exitCode;
    let completionSeen = false;
    let terminationRequested = false;

    function rejectWaiters(error) {
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }

    worker.on('message', (message) => {
      if (message.type === 'error') {
        fatalError = workerFailure(message);
        rejectWaiters(fatalError);
        return;
      }
      if (message.type === 'completion') completionSeen = true;
      const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    });
    worker.on('error', (error) => {
      fatalError = error;
      rejectWaiters(error);
    });
    const exit = new Promise((resolve) => {
      worker.on('exit', (code) => {
        exitCode = code;
        if (!terminationRequested && (code !== 0 || !completionSeen)) {
          fatalError = fatalError ?? new Error(`Race worker exited unexpectedly with code ${code}.`);
          rejectWaiters(fatalError);
        }
        resolve(code);
      });
    });

    function waitFor(type) {
      const messageIndex = messages.findIndex((message) => message.type === type);
      if (messageIndex >= 0) return Promise.resolve(messages.splice(messageIndex, 1)[0]);
      if (fatalError) return Promise.reject(fatalError);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, reject };
        waiter.timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for race worker message: ${type}.`));
        }, BARRIER_TIMEOUT_MS);
        waiters.push(waiter);
      });
    }

    return {
      start() { worker.postMessage({ type: 'start' }); },
      waitFor,
      async waitForExit() {
        let timeout;
        const code = await Promise.race([
          exit,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Timed out waiting for race worker exit.')), BARRIER_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timeout));
        expect(code).toBe(0);
      },
      async cleanup() {
        if (exitCode === undefined) {
          terminationRequested = true;
          await worker.terminate();
        }
      },
    };
  }

  function releaseGate(gate) {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  }

  async function runPostedRace(winnerOperation) {
    const fixture = createRaceFixture();
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const loserOperation = winnerOperation === 'reprepare' ? 'confirmation' : 'reprepare';
    const common = {
      databasePath: fixture.databasePath,
      releaseId: fixture.releaseId,
      token: fixture.token,
      confirmationAt: fixture.confirmationAt,
      reprepareAt: fixture.reprepareAt,
      gate: gate.buffer,
    };
    let winner;
    let loser;

    try {
      winner = createWorkerClient({ ...common, operation: winnerOperation, role: 'winner' });
      loser = createWorkerClient({ ...common, operation: loserOperation, role: 'loser' });
      const [winnerReady, loserReady] = await Promise.all([winner.waitFor('ready'), loser.waitFor('ready')]);
      expect(winnerReady.databasePath).toBe(fixture.databasePath);
      expect(loserReady.databasePath).toBe(fixture.databasePath);
      expect(winnerReady.threadId).not.toBe(loserReady.threadId);
      expect(winnerReady.busyTimeout).toBeGreaterThan(0);
      expect(loserReady.busyTimeout).toBe(winnerReady.busyTimeout);

      winner.start();
      await winner.waitFor('start');
      await winner.waitFor('checkpoint');
      expect(Atomics.load(gate, 0)).toBe(0);

      loser.start();
      await loser.waitFor('start');
      await loser.waitFor('transaction-attempt');
      expect(Atomics.load(gate, 0)).toBe(0);

      releaseGate(gate);
      const [winnerCompletion, loserCompletion] = await Promise.all([
        winner.waitFor('completion'),
        loser.waitFor('completion'),
      ]);
      await Promise.all([winner.waitForExit(), loser.waitForExit()]);

      const results = {
        [winnerOperation]: winnerCompletion.result,
        [loserOperation]: loserCompletion.result,
      };
      expect(results.reprepare.ok).toBe(true);
      if (winnerOperation === 'reprepare') {
        expect(results.confirmation).toMatchObject({
          ok: false,
          error: { code: 'confirmation_target_not_owned' },
        });
      } else {
        expect(results.confirmation).toMatchObject({
          ok: true,
          value: { target: { session_id: 'S1', status: 'posted', posted_at: '2030-01-01 00:10:00' } },
        });
      }

      const readDb = openDatabase(fixture.databasePath);
      try {
        const repository = createSocialPrepRepository(readDb);
        const rows = repository.listPlatformsByReleaseId(fixture.releaseId);
        const x = rows.find((row) => row.platform === 'x');
        expect(x).toMatchObject({
          session_id: results.reprepare.value.session.id,
          status: 'pending',
          attempts: 2,
          posted_at: null,
          updated_at: '2030-01-01 01:00:00',
        });
        expect(rows.find((row) => row.platform === 'patreon')).toEqual(fixture.patreonBefore);

        expect(repository.markPlatformPostedIfReady({
          releaseId: fixture.releaseId,
          platform: 'x',
          sessionId: 'S1',
          now: new Date(fixture.confirmationAt),
        })).toBeUndefined();
        expect(repository.listPlatformsByReleaseId(fixture.releaseId).find((row) => row.platform === 'x')).toEqual(x);

        const confirmationService = createSocialPrepService({
          db: readDb,
          socialPrepRepository: repository,
          releaseService: createReleaseService({ db: readDb }),
          socialPrepSettingsService: { isEnabled: () => true, getPlatforms: () => ['patreon', 'x'] },
          now: () => new Date(fixture.confirmationAt),
        });
        const capability = createSocialPrepCapabilityService({
          socialPrepRepository: repository,
          now: () => new Date(fixture.confirmationAt),
        });
        expect(() => confirmationService.confirmPlatformPosted({
          sessionId: 'S1',
          platform: 'x',
          authenticate: () => capability.authenticateConfirmation({
            authorization: `Bearer ${fixture.token}`,
            sessionId: 'S1',
          }),
        })).toThrowError(expect.objectContaining({ code: 'confirmation_target_not_owned' }));

        return { x, patreon: rows.find((row) => row.platform === 'patreon'), results };
      } finally {
        closeDatabase(readDb);
      }
    } finally {
      releaseGate(gate);
      await Promise.allSettled([winner?.cleanup(), loser?.cleanup()].filter(Boolean));
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }

  it('maps a competing connection’s live session to attempt_in_progress without an orphan session', () => {
    const state = setup();
    try {
      const { releaseId, repository, service } = createService(state.db);
      // The pre-existing issued row models a rival activation that committed first.
      createSocialPrepRepository(state.rivalDb).insertSession({ id: 'rival', releaseId, kind: 'initial', intentHash: 'rival', expiresAt: new Date('2030-01-01T00:15:00Z'), now: new Date('2030-01-01T00:00:00Z') });
      expect(() => service.activate({ releaseId, platforms: ['x'], intentHash: 'ours', expiresAt: new Date('2030-01-01T00:15:00Z') }))
        .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(1);
      expect(repository.listPlatformsByReleaseId(releaseId)[0].attempts).toBe(0);
    } finally { dispose(state); }
  });

  it('maps a forced SQLite busy lock from a second connection to attempt_in_progress', () => {
    const state = setup();
    try {
      const { releaseId, repository, service } = createService(state.db);
      state.db.pragma('busy_timeout = 1');
      state.rivalDb.exec('BEGIN IMMEDIATE');
      try {
        expect(() => service.activate({ releaseId, platforms: ['x'], intentHash: 'ours', expiresAt: new Date('2030-01-01T00:15:00Z') }))
          .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));
      } finally {
        state.rivalDb.exec('ROLLBACK');
      }
      expect(repository.listPlatformsByReleaseId(releaseId)[0].attempts).toBe(0);
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    } finally { dispose(state); }
  });

  it('serializes stale confirmation behind a held targeted-reprepare transaction', async () => {
    await runPostedRace('reprepare');
  }, 15_000);

  it('serializes targeted reprepare behind a held posting-confirmation transaction', async () => {
    await runPostedRace('confirmation');
  }, 15_000);
});
