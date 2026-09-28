export class ReleaseNotificationLanePausedError extends Error {
  constructor() {
    super('Release notification delivery is paused.');
    this.name = 'ReleaseNotificationLanePausedError';
  }
}

/**
 * One release-notification transport lane: a FIFO that runs at most one task
 * at a time. Scheduled deliveries and test sends for a channel share the same
 * lane, so a channel never has two sends in flight, while each channel's lane
 * progresses independently of the others.
 *
 * pause() closes admission and drops tasks that have not started (their
 * promises reject with ReleaseNotificationLanePausedError); the task already
 * running is left to finish and waitForIdle() resolves once it has.
 *
 * A task's optional `onDrop` runs synchronously when it is refused or dropped
 * instead of started. Leaving the queue is the single hand-off point: pump()
 * starts an entry synchronously as it shifts it, and pause() drops only
 * entries still queued, so each task either starts or has onDrop called,
 * never both.
 */
export function createReleaseNotificationLane() {
  const queue = [];
  let running = null;
  let admitting = true;
  let idleWaiters = [];

  function settleIdle() {
    if (running || queue.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function drop(entry) {
    try {
      entry.onDrop?.();
    } catch {
      // A drop hook failure must not keep other tasks from being dropped.
    }
    entry.reject(new ReleaseNotificationLanePausedError());
  }

  function pump() {
    if (running || queue.length === 0) return;
    const entry = queue.shift();
    running = (async () => {
      try {
        entry.resolve(await entry.task());
      } catch (error) {
        entry.reject(error);
      }
    })().finally(() => {
      running = null;
      pump();
      settleIdle();
    });
  }

  return {
    run(task, { onDrop = null } = {}) {
      return new Promise((resolve, reject) => {
        const entry = { task, onDrop, resolve, reject };
        if (!admitting) {
          drop(entry);
          return;
        }
        queue.push(entry);
        // Start on a microtask so a caller's synchronous work (e.g. a whole
        // scheduler cycle) finishes before the first send begins.
        queueMicrotask(pump);
      });
    },

    pause() {
      admitting = false;
      for (const entry of queue.splice(0)) drop(entry);
      settleIdle();
    },

    resume() {
      admitting = true;
    },

    isAdmitting() {
      return admitting;
    },

    /** No task running and none waiting. */
    isIdle() {
      return !running && queue.length === 0;
    },

    waitForIdle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },
  };
}
