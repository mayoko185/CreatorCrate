export const RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS = 60 * 1000;
/**
 * Delay before a continuation cycle after a cycle reported priority backlog
 * (its bounded time-critical page budget ran out with unhandled work left),
 * or after a lane drained a full claim wave.
 * Far below the shortest expiring phase (one minute), yet long enough that a
 * chain of continuations yields the event loop between bounded cycles.
 */
export const RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS = 1000;

/**
 * Process-local release-notification scheduler: one timer for the whole
 * subsystem (never one per release), a prompt catch-up cycle at start, then
 * roughly one cycle per minute. Cycles never overlap. Delivery failures are
 * ordinary delivery state owned by the runtime; only an unexpected cycle
 * error is logged here, once per distinct failure until a cycle succeeds, so
 * a persistent problem cannot flood the log every minute.
 *
 * When a cycle's summary reports `priorityBacklog`, one short-delay
 * continuation cycle (`runCycle({ continuation: true })`) is scheduled
 * instead of waiting for the next minute. At most one continuation is ever
 * pending; any cycle that starts cancels it (that cycle does the same
 * priority work), and stop() cancels it. A skipped, failed, or drained cycle
 * schedules none, so the normal one-minute cadence resumes.
 *
 * Every cycle also receives `requestContinuation`, which the runtime calls
 * when a lane has drained a full claim wave. It shares the same single
 * pending continuation: a request while one is pending is coalesced into it,
 * and a request arriving while a cycle runs is deferred until that cycle
 * finishes (a cycle that starts cancels any pending timer, so a request is
 * never lost to the overlap guard). After stop() requests are ignored.
 *
 * Invariant: while a cycle is active no continuation timer is pending and
 * requests only set `continuationRequested`; a cycle becomes inactive and
 * consumes that flag in one synchronous settle step. So whenever no cycle is
 * active, an outstanding request is either the single pending timer or was
 * dropped because the scheduler is stopped.
 *
 * @param {object} deps
 * @param {(options?: { continuation?: boolean, requestContinuation?: () => void }) => object|Promise<object>} deps.runCycle
 * @param {number} [deps.intervalMs]
 * @param {number} [deps.continuationDelayMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {typeof setInterval} [deps.setIntervalFn]
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {object|null} [deps.applicationLogger]
 */
export function createReleaseNotificationScheduler({
  runCycle,
  intervalMs = RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS,
  continuationDelayMs = RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  applicationLogger = null,
} = {}) {
  if (typeof runCycle !== 'function') {
    throw new Error('Release notification scheduler requires a runCycle function.');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('Release notification scheduler interval must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(continuationDelayMs) || continuationDelayMs <= 0 || continuationDelayMs >= intervalMs) {
    throw new Error('Release notification continuation delay must be a positive safe integer below the interval.');
  }

  let intervalHandle = null;
  let startupHandle = null;
  let continuationHandle = null;
  // The active cycle ({ done }), set before runCycle is entered and cleared
  // only by settleCycle().
  let current = null;
  let stopped = false;
  let lastFailure = null;
  // A continuation was requested while a cycle was running.
  let continuationRequested = false;

  function log(level, event, message, context) {
    try {
      applicationLogger?.[level]?.({
        kind: 'diagnostic', subsystem: 'release_notifications', event, message, context,
      });
    } catch {
      // Scheduler diagnostics must never alter cycle behavior.
    }
  }

  function cancelContinuation() {
    if (continuationHandle === null) return;
    clearTimeoutFn(continuationHandle);
    continuationHandle = null;
  }

  function scheduleContinuation() {
    if (stopped || continuationHandle !== null) return;
    const handle = setTimeoutFn(() => {
      // A handle that was cancelled or superseded never runs a cycle.
      if (continuationHandle !== handle) return;
      continuationHandle = null;
      void trigger({ continuation: true });
    }, continuationDelayMs);
    continuationHandle = handle;
  }

  function requestContinuation() {
    if (stopped) return;
    if (current) {
      continuationRequested = true;
      return;
    }
    scheduleContinuation();
  }

  function takeContinuationRequest() {
    const requested = continuationRequested;
    continuationRequested = false;
    return requested;
  }

  /**
   * Resolves to { summary, backlog }; never rejects. It does not consume
   * continuation requests: the cycle is still active until settleCycle().
   */
  async function executeCycle(options) {
    try {
      const summary = await runCycle({ ...options, requestContinuation });
      if (lastFailure !== null) {
        lastFailure = null;
        log('info', 'release_notifications.cycle.recovered', 'Release notification cycles are running again.');
      }
      return { summary, backlog: summary?.priorityBacklog === true };
    } catch (error) {
      // Only the error class is recorded: messages may quote configuration.
      const signature = typeof error?.name === 'string' ? error.name : 'Error';
      if (signature !== lastFailure) {
        lastFailure = signature;
        log('error', 'release_notifications.cycle.failed', 'A release notification cycle failed.', { errorName: signature });
      }
      // A failed cycle adds no backlog of its own, so it never spins; a lane
      // that drained while it ran still gets its requested follow-up.
      return { summary: { skipped: true, reason: 'error' }, backlog: false };
    }
  }

  /**
   * Ends the active cycle and consumes its deferred request in the same
   * synchronous step, so a request can neither slip between "flag read" and
   * "cycle inactive" nor be recorded after the flag was read.
   */
  function settleCycle({ summary, backlog }) {
    current = null;
    if (takeContinuationRequest() || backlog) scheduleContinuation();
    return summary;
  }

  function trigger(options = {}) {
    if (stopped) return Promise.resolve({ skipped: true, reason: 'stopped' });
    if (current) return Promise.resolve({ skipped: true, reason: 'overlap' });
    // This cycle does any pending continuation's priority work itself.
    cancelContinuation();
    // Active before runCycle is entered, so even a synchronous request defers.
    const cycle = {};
    current = cycle;
    cycle.done = executeCycle(options).then(settleCycle);
    return cycle.done;
  }

  return {
    start() {
      if (intervalHandle !== null) return false;
      stopped = false;
      startupHandle = setTimeoutFn(() => {
        startupHandle = null;
        void trigger();
      }, 0);
      intervalHandle = setIntervalFn(() => { void trigger(); }, intervalMs);
      return true;
    },

    stop() {
      stopped = true;
      continuationRequested = false;
      cancelContinuation();
      if (startupHandle !== null) {
        clearTimeoutFn(startupHandle);
        startupHandle = null;
      }
      if (intervalHandle === null) return false;
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
      return true;
    },

    /** Run one normal cycle now unless stopped or one is already running. */
    runCycle: () => trigger(),

    /** Whether a short-delay continuation cycle is pending. */
    hasPendingContinuation() {
      return continuationHandle !== null;
    },

    /** Resolves when no cycle is running. */
    waitForIdle() {
      return current ? current.done.then(() => undefined) : Promise.resolve();
    },
  };
}
