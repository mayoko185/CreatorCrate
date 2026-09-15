import { parentPort, threadId, workerData } from 'node:worker_threads';

import { closeDatabase, openDatabase } from '../../src/db.js';
import { createSocialPrepRepository } from '../../src/data/social-prep-repository.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { createSocialPrepCapabilityService } from '../../src/services/social-prep-capability.js';
import { createSocialPrepService } from '../../src/services/social-prep-service.js';

const CHECKPOINT_TIMEOUT_MS = 10_000;

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    status: error?.status,
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

function checkpointRepository(repository, gate) {
  let reached = false;
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property !== 'listPlatformsByReleaseId') return Reflect.get(target, property, receiver);
      return (...args) => {
        if (!reached) {
          reached = true;
          parentPort.postMessage({ type: 'checkpoint', threadId });
          const waitResult = Atomics.wait(gate, 0, 0, CHECKPOINT_TIMEOUT_MS);
          if (waitResult === 'timed-out') throw new Error('Timed out waiting for the transaction checkpoint release.');
        }
        return target.listPlatformsByReleaseId(...args);
      };
    },
  });
}

function contendedDatabase(db) {
  let reported = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (callback) => {
          const transaction = target.transaction(callback);
          const wrapped = (...args) => transaction(...args);
          wrapped.deferred = (...args) => transaction.deferred(...args);
          wrapped.exclusive = (...args) => transaction.exclusive(...args);
          wrapped.immediate = (...args) => {
            if (!reported) {
              reported = true;
              parentPort.postMessage({ type: 'transaction-attempt', threadId });
            }
            return transaction.immediate(...args);
          };
          return wrapped;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function runOperation({ db, repository, operation, role }) {
  const serviceDb = role === 'loser' ? contendedDatabase(db) : db;
  const serviceRepository = role === 'winner'
    ? checkpointRepository(repository, new Int32Array(workerData.gate))
    : repository;
  const now = new Date(operation === 'confirmation'
    ? workerData.confirmationAt
    : workerData.reprepareAt);
  const service = createSocialPrepService({
    db: serviceDb,
    socialPrepRepository: serviceRepository,
    releaseService: createReleaseService({ db }),
    socialPrepSettingsService: {
      isEnabled: () => true,
      getPlatforms: () => ['patreon', 'x'],
    },
    now: () => now,
  });

  if (operation === 'reprepare') {
    return service.activate({
      releaseId: workerData.releaseId,
      platforms: ['x'],
      reprepare: true,
      intentHash: 'new-intent',
      expiresAt: new Date('2030-01-01T01:15:00Z'),
    });
  }

  const capability = createSocialPrepCapabilityService({
    socialPrepRepository: serviceRepository,
    now: () => now,
  });
  return service.confirmPlatformPosted({
    sessionId: 'S1',
    platform: 'x',
    authenticate: () => capability.authenticateConfirmation({
      authorization: `Bearer ${workerData.token}`,
      sessionId: 'S1',
    }),
  });
}

let db;
try {
  db = openDatabase(workerData.databasePath);
  const repository = createSocialPrepRepository(db);
  parentPort.postMessage({
    type: 'ready',
    threadId,
    databasePath: workerData.databasePath,
    busyTimeout: db.pragma('busy_timeout', { simple: true }),
  });

  parentPort.once('message', (message) => {
    if (message?.type !== 'start') {
      parentPort.postMessage({ type: 'error', threadId, error: serializeError(new Error('Expected a start message.')) });
      closeDatabase(db);
      process.exitCode = 1;
      return;
    }

    parentPort.postMessage({ type: 'start', threadId });
    try {
      const value = runOperation({
        db,
        repository,
        operation: workerData.operation,
        role: workerData.role,
      });
      closeDatabase(db);
      db = undefined;
      parentPort.postMessage({ type: 'completion', threadId, result: { ok: true, value } });
    } catch (error) {
      closeDatabase(db);
      db = undefined;
      if (typeof error?.code === 'string') {
        parentPort.postMessage({ type: 'completion', threadId, result: { ok: false, error: serializeError(error) } });
      } else {
        parentPort.postMessage({ type: 'error', threadId, error: serializeError(error) });
        process.exitCode = 1;
      }
    }
  });
} catch (error) {
  closeDatabase(db);
  parentPort.postMessage({ type: 'error', threadId, error: serializeError(error) });
  process.exitCode = 1;
}
