import { describe, expect, it } from 'vitest';
import {
  createProcessingConcurrencyService,
  getDefaultProcessingConcurrency,
} from '../src/services/processing-concurrency-service.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('processing concurrency service', () => {
  it('runs serially and preserves input order when concurrency is one', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 1 });
    const started = [];
    let active = 0;
    let maximumActive = 0;

    const results = await service.mapBounded([1, 2, 3], async (item) => {
      started.push(item);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    expect(started).toEqual([1, 2, 3]);
    expect(maximumActive).toBe(1);
    expect(results).toEqual([2, 4, 6]);
  });

  it('never exceeds the configured cap and returns results in input order', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 3 });
    const releases = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let maximumActive = 0;

    const batch = service.mapBounded([0, 1, 2, 3], async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await releases[item].promise;
      active -= 1;
      return `result-${item}`;
    });

    await settle();
    expect(maximumActive).toBe(3);
    releases[2].resolve();
    await settle();
    releases[1].resolve();
    releases[0].resolve();
    await settle();
    releases[3].resolve();

    await expect(batch).resolves.toEqual(['result-0', 'result-1', 'result-2', 'result-3']);
    expect(maximumActive).toBe(3);
  });

  it('shares one global cap across simultaneous batches', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 2 });
    const gate = deferred();
    let active = 0;
    let maximumActive = 0;

    const worker = async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
      return item;
    };
    const first = service.mapBounded(['a', 'b'], worker);
    const second = service.mapBounded(['c', 'd'], worker);

    await settle();
    expect(maximumActive).toBe(2);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([['a', 'b'], ['c', 'd']]);
    expect(maximumActive).toBe(2);
  });

  it('drains already-started workers, preserves the first failure, and stops new work', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 2 });
    const firstFailure = new Error('first failure');
    const releaseFailure = deferred();
    const releaseRunningWorker = deferred();
    const started = [];

    const batch = service.mapBounded([0, 1, 2, 3], async (item) => {
      started.push(item);
      if (item === 0) {
        await releaseFailure.promise;
        throw firstFailure;
      }
      if (item === 1) await releaseRunningWorker.promise;
      return item;
    });

    await settle();
    expect(started).toEqual([0, 1]);
    releaseFailure.resolve();
    await settle();
    expect(started).toEqual([0, 1]);

    let settled = false;
    void batch.then(() => { settled = true; }, () => { settled = true; });
    await settle();
    expect(settled).toBe(false);

    releaseRunningWorker.resolve();
    await expect(batch).rejects.toBe(firstFailure);
    expect(started).toEqual([0, 1]);
  });

  it('releases all capacity after failure and remains usable for later batches', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 2 });
    const failure = new Error('failed batch');

    await expect(service.mapBounded([1, 2], (item) => {
      if (item === 1) throw failure;
      return item;
    })).rejects.toBe(failure);

    await expect(service.mapBounded([3, 4], async (item) => item * 2))
      .resolves.toEqual([6, 8]);
  });

  it('drains and rejects with undefined without starting queued work, then releases capacity', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 2 });
    const releaseFailure = deferred();
    const releaseRunningWorker = deferred();
    const started = [];

    const batch = service.mapBounded([0, 1, 2], async (item) => {
      started.push(item);
      if (item === 0) {
        await releaseFailure.promise;
        throw undefined;
      }
      if (item === 1) await releaseRunningWorker.promise;
      return item;
    });

    await settle();
    expect(started).toEqual([0, 1]);
    releaseFailure.resolve();
    await settle();
    expect(started).toEqual([0, 1]);

    let settled = false;
    void batch.then(() => { settled = true; }, () => { settled = true; });
    await settle();
    expect(settled).toBe(false);

    releaseRunningWorker.resolve();
    await expect(batch).rejects.toBeUndefined();
    expect(started).toEqual([0, 1]);
    await expect(service.mapBounded([3], async (item) => item * 2)).resolves.toEqual([6]);
  });

  it('preserves a null first failure while unrelated batches continue and capacity recovers', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 2 });
    const releaseNullFailure = deferred();
    const releaseLaterFailure = deferred();
    const unrelatedStarted = deferred();
    const started = [];
    const laterFailure = new Error('later failure');

    const failedBatch = service.mapBounded([0, 1, 2], async (item) => {
      started.push(item);
      if (item === 0) {
        await releaseNullFailure.promise;
        throw null;
      }
      if (item === 1) {
        await releaseLaterFailure.promise;
        throw laterFailure;
      }
      return item;
    });
    await settle();
    expect(started).toEqual([0, 1]);

    const unrelatedBatch = service.mapBounded(['other'], async (item) => {
      unrelatedStarted.resolve();
      return item;
    });
    await settle();

    releaseNullFailure.resolve();
    await unrelatedStarted.promise;
    expect(started).toEqual([0, 1]);

    releaseLaterFailure.resolve();
    await expect(failedBatch).rejects.toBe(null);
    await expect(unrelatedBatch).resolves.toEqual(['other']);
    await expect(service.mapBounded([4], async (item) => item * 2)).resolves.toEqual([8]);
  });

  it('returns an empty result for empty input', async () => {
    const service = createProcessingConcurrencyService({ concurrency: 1 });
    await expect(service.mapBounded([], () => { throw new Error('not called'); })).resolves.toEqual([]);
  });

  it('rejects invalid concurrency and caps the default CPU-based value', () => {
    expect(() => createProcessingConcurrencyService({ concurrency: 0 })).toThrow(TypeError);
    expect(() => createProcessingConcurrencyService({ concurrency: 1.5 })).toThrow(TypeError);
    expect(() => createProcessingConcurrencyService({ concurrency: '2' })).toThrow(TypeError);
    expect(getDefaultProcessingConcurrency(1)).toBe(1);
    expect(getDefaultProcessingConcurrency(3)).toBe(3);
    expect(getDefaultProcessingConcurrency(99)).toBe(4);
    expect(getDefaultProcessingConcurrency(0)).toBe(1);
  });
});
