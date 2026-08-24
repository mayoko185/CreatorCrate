import { describe, it, expect } from 'vitest';
import {
  createProjectOperationCoordinator,
  ProjectOperationError,
} from '../src/services/project-operation-coordinator.js';

describe('project operation coordinator', () => {
  it('runs a callback and returns its result', () => {
    const coordinator = createProjectOperationCoordinator();
    const result = coordinator.run(1, () => 'done');
    expect(result).toBe('done');
  });

  it('rejects same-project re-entry while an operation is in progress', () => {
    const coordinator = createProjectOperationCoordinator();

    let reentryError;
    coordinator.run(1, () => {
      try {
        coordinator.run(1, () => 'inner');
      } catch (err) {
        reentryError = err;
      }
    });

    expect(reentryError).toBeInstanceOf(ProjectOperationError);
    expect(reentryError.code).toBe('PROJECT_OPERATION_IN_PROGRESS');
  });

  it('permits operations for different projects concurrently', () => {
    const coordinator = createProjectOperationCoordinator();

    let innerResult;
    coordinator.run(1, () => {
      innerResult = coordinator.run(2, () => 'project-2-done');
    });

    expect(innerResult).toBe('project-2-done');
  });

  it('releases the lock after a successful run', () => {
    const coordinator = createProjectOperationCoordinator();

    coordinator.run(1, () => 'first');
    expect(coordinator.isActive(1)).toBe(false);

    const second = coordinator.run(1, () => 'second');
    expect(second).toBe('second');
  });

  it('releases the lock after a thrown failure', () => {
    const coordinator = createProjectOperationCoordinator();

    expect(() => {
      coordinator.run(1, () => {
        throw new Error('boom');
      });
    }).toThrow('boom');

    expect(coordinator.isActive(1)).toBe(false);

    const result = coordinator.run(1, () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('rejects non-positive-integer project IDs', () => {
    const coordinator = createProjectOperationCoordinator();

    for (const invalid of [0, -1, 1.5, NaN, '1', null, undefined]) {
      expect(() => coordinator.run(invalid, () => {})).toThrow(ProjectOperationError);
    }
  });

  it('reports invalid project IDs with a distinct code from re-entry conflicts', () => {
    const coordinator = createProjectOperationCoordinator();

    try {
      coordinator.run(0, () => {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectOperationError);
      expect(err.code).toBe('INVALID_PROJECT_ID');
    }
  });

  it('queues same-project async operations in submission order and releases state after completion', async () => {
    const coordinator = createProjectOperationCoordinator();
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const order = [];

    const operation = coordinator.runAsync(1, async () => {
      order.push('first-start');
      entered();
      await gate;
      order.push('first-end');
      return 'async-done';
    });
    const queued = coordinator.runAsync(1, () => {
      order.push('second');
      return 'queued-done';
    });

    await enteredPromise;
    expect(coordinator.isActive(1)).toBe(true);
    expect(() => coordinator.run(1, () => 'blocked')).toThrow(ProjectOperationError);
    expect(order).toEqual(['first-start']);

    release();
    await expect(operation).resolves.toBe('async-done');
    await expect(queued).resolves.toBe('queued-done');
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(coordinator.isActive(1)).toBe(false);
  });

  it('runs asynchronous operations for different projects independently', async () => {
    const coordinator = createProjectOperationCoordinator();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const operation = coordinator.runAsync(1, async () => {
      await gate;
      return 'project-1-done';
    });

    expect(() => coordinator.run(1, () => 'blocked')).toThrow(ProjectOperationError);
    await expect(coordinator.runAsync(2, () => 'project-2-done')).resolves.toBe('project-2-done');
    expect(coordinator.isActive(2)).toBe(false);

    release();
    await expect(operation).resolves.toBe('project-1-done');
    expect(coordinator.isActive(1)).toBe(false);
  });

  it('rejects an async contender while a synchronous owner is active', async () => {
    const coordinator = createProjectOperationCoordinator();
    let asyncOperation;
    let asyncStarted = false;

    coordinator.run(1, () => {
      asyncOperation = coordinator.runAsync(1, () => {
        asyncStarted = true;
      });
      expect(coordinator.isActive(1)).toBe(true);
      expect(asyncStarted).toBe(false);
    });

    await expect(asyncOperation).rejects.toMatchObject({
      code: 'PROJECT_OPERATION_IN_PROGRESS',
    });
    expect(asyncStarted).toBe(false);
    expect(coordinator.isActive(1)).toBe(false);
  });

  it('continues the same-project async queue after a rejected callback', async () => {
    const coordinator = createProjectOperationCoordinator();
    const order = [];

    const failed = coordinator.runAsync(1, async () => {
      order.push('failed');
      await Promise.resolve();
      throw new Error('async boom');
    });
    const recovered = coordinator.runAsync(1, () => {
      order.push('recovered');
      return 'recovered';
    });

    await expect(failed).rejects.toThrow('async boom');
    await expect(recovered).resolves.toBe('recovered');
    expect(order).toEqual(['failed', 'recovered']);
    expect(coordinator.isActive(1)).toBe(false);
  });
});
