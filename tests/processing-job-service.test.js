import { describe, expect, it } from 'vitest';
import { createProcessingJobService } from '../src/services/processing-job-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';

function createService() {
  return createProcessingJobService({
    projectOperationCoordinator: createProjectOperationCoordinator(),
  });
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('processing job service', () => {
  it('moves a job from queued to running to succeeded with its result', async () => {
    const service = createService();
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const jobId = service.enqueue({
      projectId: 1,
      execute: async () => {
        begin();
        await gate;
        return { processed: 3 };
      },
    });

    await started;
    expect(service.getJob(jobId)).toMatchObject({
      id: jobId,
      projectId: 1,
      state: 'running',
      progress: null,
      result: null,
      error: null,
    });

    release();
    await settle();
    expect(service.getJob(jobId)).toMatchObject({
      state: 'succeeded',
      result: { processed: 3 },
      error: null,
    });
  });

  it('records a stable client-safe failure without exposing the thrown error', async () => {
    const service = createService();
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const jobId = service.enqueue({
      projectId: 1,
      execute: async () => {
        begin();
        await gate;
        throw new Error('private filesystem path: C:/secret');
      },
    });

    await started;
    expect(service.getJob(jobId)?.state).toBe('running');
    expect(service.hasActiveJobs()).toBe(true);
    release();
    await settle();
    expect(service.getJob(jobId)).toEqual({
      id: jobId,
      projectId: 1,
      state: 'failed',
      progress: null,
      result: null,
      error: {
        code: 'PROCESSING_FAILED',
        message: 'Processing failed.',
      },
    });
    expect(service.hasActiveJobs()).toBe(false);
  });

  it('accepts progress updates only while a job is running', async () => {
    const service = createService();
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const jobId = service.enqueue({
      projectId: 1,
      execute: async ({ updateProgress }) => {
        expect(updateProgress({ completed: 1, total: 3 })).toBe(true);
        begin();
        await gate;
      },
    });

    await started;
    expect(service.getJob(jobId)?.progress).toEqual({ completed: 1, total: 3 });
    release();
    await settle();
    expect(service.updateProgress(jobId, { completed: 2, total: 3 })).toBe(false);
  });

  it('preserves the last valid progress snapshot when execution fails', async () => {
    const service = createService();
    const jobId = service.enqueue({
      projectId: 1,
      execute: ({ updateProgress }) => {
        updateProgress({ completed: 1, total: 3 });
        expect(updateProgress({ completed: 0, total: 3 })).toBe(false);
        throw new Error('staging failed');
      },
    });

    await settle();
    expect(service.getJob(jobId)).toMatchObject({
      state: 'failed',
      progress: { completed: 1, total: 3 },
      error: { code: 'PROCESSING_FAILED', message: 'Processing failed.' },
    });
  });

  it('cancels a queued job before the coordinator invokes its work', async () => {
    const service = createService();
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let secondExecuted = false;

    service.enqueue({
      projectId: 1,
      execute: () => firstGate,
    });
    const queuedJobId = service.enqueue({
      projectId: 1,
      execute: () => { secondExecuted = true; },
    });

    expect(service.getJob(queuedJobId)?.state).toBe('queued');
    expect(service.cancel(queuedJobId)).toBe(true);
    expect(service.getJob(queuedJobId)?.state).toBe('cancelled');

    releaseFirst();
    await settle();
    expect(secondExecuted).toBe(false);
    expect(service.getJob(queuedJobId)?.state).toBe('cancelled');
  });

  it('refuses cancellation for a running job', async () => {
    const service = createService();
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const jobId = service.enqueue({
      projectId: 1,
      execute: async () => {
        begin();
        await gate;
      },
    });

    await started;
    expect(service.cancel(jobId)).toBe(false);
    expect(service.getJob(jobId)?.state).toBe('running');
    release();
    await settle();
  });

  it('returns null for an unknown job', () => {
    expect(createService().getJob('unknown-job')).toBeNull();
  });

  it('reports active work before, during, and after execution', async () => {
    const service = createService();
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    expect(service.hasActiveJobs()).toBe(false);
    service.enqueue({
      projectId: 1,
      execute: async () => {
        begin();
        await gate;
      },
    });
    expect(service.hasActiveJobs()).toBe(true);
    await started;
    expect(service.hasActiveJobs()).toBe(true);
    release();
    await settle();
    expect(service.hasActiveJobs()).toBe(false);
  });

  it('keeps independent jobs isolated', async () => {
    const service = createService();
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let secondStarted;
    const secondStartedPromise = new Promise((resolve) => { secondStarted = resolve; });

    const firstJobId = service.enqueue({
      projectId: 1,
      execute: () => firstGate,
    });
    const secondJobId = service.enqueue({
      projectId: 2,
      execute: () => {
        secondStarted();
        return { processed: 2 };
      },
    });

    await secondStartedPromise;
    await settle();
    expect(service.getJob(firstJobId)?.state).toBe('running');
    expect(service.getJob(secondJobId)).toMatchObject({
      projectId: 2,
      state: 'succeeded',
      result: { processed: 2 },
    });

    releaseFirst();
    await settle();
    expect(service.getJob(firstJobId)?.state).toBe('succeeded');
  });

  it('retains newly terminal succeeded, failed, and cancelled jobs for polling', async () => {
    let time = 0;
    const callbacks = [];
    const service = createProcessingJobService({
      projectOperationCoordinator: {
        runAsync: (_projectId, callback) => {
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
      now: () => time,
      terminalJobTtlMs: 100,
      maxTerminalJobs: 3,
    });

    const succeededJobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    await callbacks.shift()();
    const failedJobId = service.enqueue({ projectId: 1, execute: () => { throw new Error('nope'); } });
    await callbacks.shift()();
    const cancelledJobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    expect(service.cancel(cancelledJobId)).toBe(true);

    expect(service.getJob(succeededJobId)).toMatchObject({ state: 'succeeded', result: { processed: 1 } });
    expect(service.getJob(failedJobId)).toMatchObject({ state: 'failed', error: { code: 'PROCESSING_FAILED' } });
    expect(service.getJob(cancelledJobId)).toMatchObject({ state: 'cancelled' });
  });

  it('evicts the oldest terminal jobs first across every terminal state', async () => {
    const callbacks = [];
    const service = createProcessingJobService({
      projectOperationCoordinator: {
        runAsync: (_projectId, callback) => {
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
      terminalJobTtlMs: 100,
      maxTerminalJobs: 2,
    });

    const succeededJobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    await callbacks.shift()();
    const failedJobId = service.enqueue({ projectId: 1, execute: () => { throw new Error('nope'); } });
    await callbacks.shift()();
    const cancelledJobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    service.cancel(cancelledJobId);

    expect(service.getJob(succeededJobId)).toBeNull();
    expect(service.getJob(failedJobId)).toMatchObject({ state: 'failed' });
    expect(service.getJob(cancelledJobId)).toMatchObject({ state: 'cancelled' });
  });

  it('expires terminal jobs by TTL without using real time', async () => {
    let time = 0;
    const callbacks = [];
    const service = createProcessingJobService({
      projectOperationCoordinator: {
        runAsync: (_projectId, callback) => {
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
      now: () => time,
      terminalJobTtlMs: 100,
      maxTerminalJobs: 10,
    });

    const jobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    await callbacks.shift()();
    expect(service.getJob(jobId)).toMatchObject({ state: 'succeeded' });

    time = 100;
    expect(service.getJob(jobId)).toBeNull();
  });

  it('never evicts queued or running jobs and keeps active detection bounded', async () => {
    const callbacks = [];
    let beginRunning;
    let releaseRunning;
    const runningStarted = new Promise((resolve) => { beginRunning = resolve; });
    const runningGate = new Promise((resolve) => { releaseRunning = resolve; });
    const service = createProcessingJobService({
      projectOperationCoordinator: {
        runAsync: (_projectId, callback) => {
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
      terminalJobTtlMs: 100,
      maxTerminalJobs: 1,
    });

    const queuedJobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    const runningJobId = service.enqueue({
      projectId: 1,
      execute: async () => {
        beginRunning();
        await runningGate;
        return { processed: 1 };
      },
    });
    const runningPromise = callbacks[1]();
    await runningStarted;

    const terminalJobId = service.enqueue({ projectId: 1, execute: () => ({ processed: 1 }) });
    await callbacks[2]();

    expect(service.getJob(queuedJobId)).toMatchObject({ state: 'queued' });
    expect(service.getJob(runningJobId)).toMatchObject({ state: 'running' });
    expect(service.getJob(terminalJobId)).toMatchObject({ state: 'succeeded' });
    expect(service.hasActiveJobs()).toBe(true);

    expect(service.cancel(queuedJobId)).toBe(true);
    releaseRunning();
    await runningPromise;

    expect(service.hasActiveJobs()).toBe(false);
  });
  it('reserves pending submissions and transfers them to queued jobs without an activity gap', async () => {
    const service = createService();
    const reservation = service.reserveSubmission(1);

    expect(service.hasActiveJobs()).toBe(true);

    const jobId = service.enqueue({
      projectId: 1,
      reservation,
      execute: () => ({ processed: 1 }),
    });

    expect(reservation.release()).toBe(false);
    expect(service.getJob(jobId)).not.toBeNull();
    expect(service.hasActiveJobs()).toBe(true);

    await settle();
    expect(service.hasActiveJobs()).toBe(false);
  });

  it('does not accept a pending-submission reservation for another project', () => {
    const service = createService();
    const reservation = service.reserveSubmission(2);

    expect(() => service.enqueue({ projectId: 1, reservation, execute: () => undefined }))
      .toThrow(/active submission reservation/);
    expect(reservation.release()).toBe(true);
    expect(service.hasActiveJobs()).toBe(false);
  });
});
