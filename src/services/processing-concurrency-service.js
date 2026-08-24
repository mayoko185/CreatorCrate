import { availableParallelism } from 'node:os';

export function getDefaultProcessingConcurrency(parallelism = availableParallelism()) {
  if (!Number.isFinite(parallelism)) return 1;
  return Math.max(1, Math.min(Math.floor(parallelism), 4));
}

function assertConcurrency(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('Processing concurrency must be a positive integer.');
  }
}

/**
 * Creates the application-wide bounded pool used by processing operations.
 * Each mapBounded call is a batch; all batches share this instance's cap.
 */
export function createProcessingConcurrencyService({
  concurrency = getDefaultProcessingConcurrency(),
} = {}) {
  assertConcurrency(concurrency);

  let running = 0;
  const pending = [];

  function settleFailedBatch(batch) {
    if (batch.failed && batch.running === 0 && !batch.settled) {
      batch.settled = true;
      batch.reject(batch.failure);
    }
  }

  function pump() {
    while (running < concurrency && pending.length > 0) {
      const task = pending.shift();
      const { batch } = task;
      if (batch.failed || batch.settled) {
        settleFailedBatch(batch);
        continue;
      }

      running += 1;
      batch.running += 1;
      Promise.resolve()
        .then(() => batch.worker(task.item, task.index))
        .then(
          (result) => { batch.results[task.index] = result; },
          (err) => {
            if (!batch.failed) {
              batch.failed = true;
              batch.failure = err;
            }
          }
        )
        .finally(() => {
          running -= 1;
          batch.running -= 1;

          if (batch.failed) {
            settleFailedBatch(batch);
          } else if (batch.nextIndex < batch.items.length) {
            const index = batch.nextIndex;
            batch.nextIndex += 1;
            pending.push({ batch, item: batch.items[index], index });
          } else if (batch.running === 0 && !batch.settled) {
            batch.settled = true;
            batch.resolve(batch.results);
          }

          pump();
        });
    }
  }

  function mapBounded(items, worker) {
    if (!Array.isArray(items)) {
      throw new TypeError('mapBounded requires an array of items.');
    }
    if (typeof worker !== 'function') {
      throw new TypeError('mapBounded requires a worker function.');
    }
    if (items.length === 0) return Promise.resolve([]);

    return new Promise((resolve, reject) => {
      const batch = {
        items,
        worker,
        results: new Array(items.length),
        nextIndex: 0,
        running: 0,
        failed: false,
        failure: undefined,
        settled: false,
        resolve,
        reject,
      };
      const initialTasks = Math.min(concurrency, items.length);
      for (let index = 0; index < initialTasks; index += 1) {
        batch.nextIndex += 1;
        pending.push({ batch, item: items[index], index });
      }
      pump();
    });
  }

  return Object.freeze({
    concurrency,
    mapBounded,
  });
}
