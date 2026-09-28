import { describe, it, expect } from 'vitest';
import {
  createReleaseNotificationScheduler,
  RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS,
  RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS,
} from '../src/services/release-notification-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeoutFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; timeouts.push(handle); return handle; },
    clearTimeoutFn: (handle) => { handle.cleared = true; },
    setIntervalFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
    clearIntervalFn: (handle) => { handle.cleared = true; },
  };
}

function createLogger() {
  const entries = [];
  const record = (level) => (entry) => entries.push({ level, ...entry });
  return { entries, info: record('info'), warn: record('warn'), error: record('error') };
}

describe('release notification scheduler', () => {
  it('runs a prompt startup cycle and then one cycle per minute on a single interval', async () => {
    const timers = fakeTimers();
    let cycles = 0;
    const scheduler = createReleaseNotificationScheduler({ runCycle: () => { cycles += 1; return {}; }, ...timers });

    expect(scheduler.start()).toBe(true);
    expect(scheduler.start()).toBe(false);
    expect(timers.timeouts).toHaveLength(1);
    expect(timers.timeouts[0].ms).toBe(0);
    expect(timers.intervals).toHaveLength(1);
    expect(timers.intervals[0].ms).toBe(RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS);
    expect(RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS).toBe(60 * 1000);

    timers.timeouts[0].fn();
    await scheduler.waitForIdle();
    timers.intervals[0].fn();
    await scheduler.waitForIdle();
    timers.intervals[0].fn();
    await scheduler.waitForIdle();
    expect(cycles).toBe(3);
  });

  it('never overlaps cycles', async () => {
    const running = deferred();
    let cycles = 0;
    const scheduler = createReleaseNotificationScheduler({
      runCycle: () => { cycles += 1; return running.promise; },
      ...fakeTimers(),
    });
    const first = scheduler.runCycle();
    await expect(scheduler.runCycle()).resolves.toEqual({ skipped: true, reason: 'overlap' });
    expect(cycles).toBe(1);
    running.resolve({ claimed: 0 });
    await expect(first).resolves.toEqual({ claimed: 0 });
    await scheduler.runCycle();
    expect(cycles).toBe(2);
  });

  it('stops admitting cycles and lets a running cycle finish', async () => {
    const timers = fakeTimers();
    const running = deferred();
    const scheduler = createReleaseNotificationScheduler({ runCycle: () => running.promise, ...timers });
    scheduler.start();
    const cycle = scheduler.runCycle();
    expect(scheduler.stop()).toBe(true);
    expect(timers.timeouts[0].cleared).toBe(true);
    expect(timers.intervals[0].cleared).toBe(true);
    await expect(scheduler.runCycle()).resolves.toEqual({ skipped: true, reason: 'stopped' });

    let idle = false;
    const waiting = scheduler.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    running.resolve({});
    await cycle;
    await waiting;
    expect(idle).toBe(true);
  });

  it('contains cycle errors and logs a repeated failure once, without its message', async () => {
    const applicationLogger = createLogger();
    let fail = true;
    const scheduler = createReleaseNotificationScheduler({
      runCycle: () => {
        if (fail) throw new TypeError('secret-token-in-message');
        return {};
      },
      applicationLogger,
      ...fakeTimers(),
    });
    await expect(scheduler.runCycle()).resolves.toEqual({ skipped: true, reason: 'error' });
    await scheduler.runCycle();
    await scheduler.runCycle();
    expect(applicationLogger.entries.map((entry) => entry.event)).toEqual(['release_notifications.cycle.failed']);
    expect(applicationLogger.entries[0].context).toEqual({ errorName: 'TypeError' });
    expect(JSON.stringify(applicationLogger.entries)).not.toContain('secret-token-in-message');

    fail = false;
    await scheduler.runCycle();
    expect(applicationLogger.entries.map((entry) => entry.event))
      .toEqual(['release_notifications.cycle.failed', 'release_notifications.cycle.recovered']);
  });

  describe('priority backlog continuation', () => {
    function scriptedScheduler(summaries) {
      const timers = fakeTimers();
      const calls = [];
      const scheduler = createReleaseNotificationScheduler({
        runCycle: (options) => {
          const { requestContinuation, ...rest } = options;
          calls.push(rest);
          const next = summaries.shift() ?? { priorityBacklog: false };
          if (next instanceof Error) throw next;
          return next;
        },
        ...timers,
      });
      return { timers, calls, scheduler };
    }

    it('runs one short-delay continuation while backlog remains, then returns to the minute cadence', async () => {
      const { timers, calls, scheduler } = scriptedScheduler([
        { priorityBacklog: true }, { priorityBacklog: true }, { priorityBacklog: false },
      ]);
      scheduler.start();
      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      expect(timers.timeouts).toHaveLength(2);
      expect(timers.timeouts[1].ms).toBe(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS);
      expect(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS).toBeLessThan(RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS);

      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      timers.timeouts[2].fn();
      await scheduler.waitForIdle();
      expect(calls).toEqual([{}, { continuation: true }, { continuation: true }]);
      // Drained: no further continuation; only the one minute interval remains.
      expect(timers.timeouts).toHaveLength(3);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(timers.intervals).toHaveLength(1);
      expect(timers.intervals[0].ms).toBe(RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS);
    });

    it('runs exactly one cycle when the minute tick and a pending continuation coincide', async () => {
      const { timers, calls, scheduler } = scriptedScheduler([{ priorityBacklog: true }, { priorityBacklog: false }]);
      scheduler.start();
      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      expect(scheduler.hasPendingContinuation()).toBe(true);

      timers.intervals[0].fn();
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(calls).toEqual([{}, {}]);
      expect(timers.timeouts[1].cleared).toBe(true);
      expect(scheduler.hasPendingContinuation()).toBe(false);

      // A late firing of the superseded handle never runs a cycle.
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(calls).toHaveLength(2);
    });

    it('never overlaps a continuation with a running cycle', async () => {
      const running = deferred();
      const timers = fakeTimers();
      let cycles = 0;
      const scheduler = createReleaseNotificationScheduler({
        runCycle: () => { cycles += 1; return cycles === 1 ? { priorityBacklog: true } : running.promise; },
        ...timers,
      });
      await scheduler.runCycle();
      const minuteCycle = scheduler.runCycle();
      // The minute cycle took over the continuation's work and cancelled it.
      expect(timers.timeouts[0].cleared).toBe(true);
      timers.timeouts[0].fn();
      await expect(scheduler.runCycle()).resolves.toEqual({ skipped: true, reason: 'overlap' });
      running.resolve({ priorityBacklog: false });
      await minuteCycle;
      expect(cycles).toBe(2);
    });

    it('cancels a pending continuation on stop and schedules none after it', async () => {
      const { timers, calls, scheduler } = scriptedScheduler([{ priorityBacklog: true }]);
      scheduler.start();
      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      expect(scheduler.stop()).toBe(true);
      expect(timers.timeouts[1].cleared).toBe(true);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(calls).toHaveLength(1);
    });

    it('does not schedule a continuation when the cycle was stopped while it ran', async () => {
      const running = deferred();
      const timers = fakeTimers();
      const scheduler = createReleaseNotificationScheduler({ runCycle: () => running.promise, ...timers });
      scheduler.start();
      const cycle = scheduler.runCycle();
      scheduler.stop();
      running.resolve({ priorityBacklog: true });
      await cycle;
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(timers.timeouts).toHaveLength(1);
    });

    it('never spins on a failing cycle: an error schedules no continuation', async () => {
      const { timers, scheduler } = scriptedScheduler([{ priorityBacklog: true }, new TypeError('boom')]);
      scheduler.start();
      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(timers.timeouts).toHaveLength(2);
    });

    describe('continuation requests (drained full claim waves)', () => {
      function requestingScheduler(runCycleImpl = () => ({ priorityBacklog: false })) {
        const timers = fakeTimers();
        const calls = [];
        let request = null;
        const scheduler = createReleaseNotificationScheduler({
          runCycle: (options) => {
            const { requestContinuation, ...rest } = options;
            request = requestContinuation;
            calls.push(rest);
            return runCycleImpl(requestContinuation);
          },
          ...timers,
        });
        return { timers, calls, scheduler, request: () => request() };
      }

      it('coalesces several lane-drain requests into one pending continuation', async () => {
        const { timers, calls, scheduler, request } = requestingScheduler();
        scheduler.start();
        timers.timeouts[0].fn();
        await scheduler.waitForIdle();
        expect(timers.timeouts).toHaveLength(1);

        request();
        request();
        request();
        expect(timers.timeouts).toHaveLength(2);
        expect(timers.timeouts[1].ms).toBe(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS);
        timers.timeouts[1].fn();
        await scheduler.waitForIdle();
        expect(calls).toEqual([{}, { continuation: true }]);
        // No request during that continuation: back to the minute cadence.
        expect(timers.timeouts).toHaveLength(2);
        expect(scheduler.hasPendingContinuation()).toBe(false);
      });

      it('coalesces a lane-drain request with priority backlog', async () => {
        const { timers, calls, scheduler } = requestingScheduler((requestContinuation) => {
          requestContinuation();
          return { priorityBacklog: true };
        });
        await scheduler.runCycle();
        expect(timers.timeouts).toHaveLength(1);
        expect(calls).toEqual([{}]);
      });

      it('defers a request made while a cycle runs until that cycle finishes', async () => {
        const running = deferred();
        const { timers, calls, scheduler, request } = requestingScheduler(() => running.promise);
        const cycle = scheduler.runCycle();
        request();
        expect(timers.timeouts).toHaveLength(0);
        running.resolve({ priorityBacklog: false });
        await cycle;
        expect(timers.timeouts).toHaveLength(1);
        expect(calls).toEqual([{}]);
      });

      it('honors a request made during a cycle that superseded the pending continuation', async () => {
        const running = deferred();
        let cycles = 0;
        const { timers, calls, scheduler, request } = requestingScheduler(() => {
          cycles += 1;
          return cycles === 2 ? running.promise : { priorityBacklog: false };
        });
        await scheduler.runCycle();
        request();
        expect(scheduler.hasPendingContinuation()).toBe(true);
        // A manual cycle cancels it; a request made during that cycle is honored afterwards.
        const manual = scheduler.runCycle();
        expect(timers.timeouts[0].cleared).toBe(true);
        request();
        timers.timeouts[0].fn(); // superseded: a no-op
        running.resolve({ priorityBacklog: false });
        await manual;
        expect(timers.timeouts).toHaveLength(2);
        timers.timeouts[1].fn();
        await scheduler.waitForIdle();
        expect(calls).toEqual([{}, {}, { continuation: true }]);
      });

      describe('requests while a cycle settles', () => {
        const HOPS = 12;
        const hop = async (count) => { for (let i = 0; i < count; i += 1) await Promise.resolve(); };

        /**
         * Resolve the cycle's runCycle promise, let `hops` microtasks pass
         * (the cycle's own settlement interleaves with them), then call
         * `act`. Reports whether a request at that point was deferred (the
         * cycle was still active: no timer appeared at the call).
         */
        async function settleWith(hops, act, { summary = { priorityBacklog: false }, fail = false } = {}) {
          const running = deferred();
          let cycles = 0;
          const env = requestingScheduler(() => {
            cycles += 1;
            return cycles === 1 ? running.promise : { priorityBacklog: false };
          });
          env.scheduler.start();
          env.timers.timeouts[0].fn();
          const before = env.timers.timeouts.length;
          if (fail) running.reject(new TypeError('boom')); else running.resolve(summary);
          await hop(hops);
          const deferredAtCall = act(env) === false ? null : env.timers.timeouts.length === before;
          await env.scheduler.waitForIdle();
          await hop(HOPS);
          return { ...env, deferredAtCall };
        }

        const openContinuations = (timers) => timers.timeouts
          .filter((handle) => handle.ms === RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS && !handle.cleared);

        /** The last hop count at which a request still arrives while the cycle is active. */
        async function lastActiveHop() {
          let last = -1;
          for (let hops = 0; hops <= HOPS; hops += 1) {
            const { deferredAtCall, scheduler } = await settleWith(hops, ({ request }) => { request(); });
            scheduler.stop();
            if (deferredAtCall) last = hops;
          }
          return last;
        }

        it('schedules the continuation for a request made in the last moment before the cycle goes idle', async () => {
          const hops = await lastActiveHop();
          expect(hops).toBeGreaterThanOrEqual(0);
          expect(hops).toBeLessThan(HOPS);
          const { timers, calls, scheduler, deferredAtCall } = await settleWith(hops, ({ request }) => { request(); });
          expect(deferredAtCall).toBe(true);
          // Idle, with exactly one short continuation pending.
          expect(await Promise.race([scheduler.waitForIdle().then(() => 'idle'), hop(1).then(() => 'busy')])).toBe('idle');
          expect(scheduler.hasPendingContinuation()).toBe(true);
          expect(openContinuations(timers)).toHaveLength(1);
          openContinuations(timers)[0].fn();
          await scheduler.waitForIdle();
          expect(calls).toEqual([{}, { continuation: true }]);
          expect(scheduler.hasPendingContinuation()).toBe(false);
          scheduler.stop();
        });

        it('never loses a request at any point from cycle completion to idle', async () => {
          const seen = new Set();
          for (let hops = 0; hops <= HOPS; hops += 1) {
            const { timers, calls, scheduler, deferredAtCall } = await settleWith(hops, ({ request }) => { request(); });
            seen.add(deferredAtCall);
            expect(openContinuations(timers)).toHaveLength(1);
            openContinuations(timers)[0].fn();
            await scheduler.waitForIdle();
            expect(calls).toEqual([{}, { continuation: true }]);
            scheduler.stop();
          }
          // The sweep covered requests both during the cycle and after it went idle.
          expect(seen).toEqual(new Set([true, false]));
        });

        it('coalesces several requests during settlement into one continuation', async () => {
          const hops = await lastActiveHop();
          const { timers, calls, scheduler } = await settleWith(hops, ({ request }) => { request(); request(); request(); });
          expect(openContinuations(timers)).toHaveLength(1);
          expect(timers.timeouts).toHaveLength(2);
          openContinuations(timers)[0].fn();
          await scheduler.waitForIdle();
          expect(calls).toEqual([{}, { continuation: true }]);
          expect(scheduler.hasPendingContinuation()).toBe(false);
          scheduler.stop();
        });

        it('coalesces a settlement request with priority backlog', async () => {
          const hops = await lastActiveHop();
          const { timers, scheduler } = await settleWith(hops, ({ request }) => { request(); }, {
            summary: { priorityBacklog: true },
          });
          expect(openContinuations(timers)).toHaveLength(1);
          scheduler.stop();
        });

        it('keeps no continuation when stopped while a settlement request is outstanding', async () => {
          const hops = await lastActiveHop();
          for (const at of [hops, hops + 1]) {
            const { timers, calls, scheduler } = await settleWith(at, ({ request, scheduler: s }) => { request(); s.stop(); });
            expect(scheduler.hasPendingContinuation()).toBe(false);
            expect(openContinuations(timers)).toHaveLength(0);
            for (const handle of timers.timeouts) handle.fn();
            await scheduler.waitForIdle();
            expect(calls).toEqual([{}]);
          }
        });

        it('honors a request made while a failing cycle settles, without an error retry of its own', async () => {
          const hops = await lastActiveHop();
          const withRequest = await settleWith(hops, ({ request }) => { request(); }, { fail: true });
          expect(openContinuations(withRequest.timers)).toHaveLength(1);
          withRequest.scheduler.stop();

          const withoutRequest = await settleWith(hops, () => false, { fail: true });
          expect(withoutRequest.scheduler.hasPendingContinuation()).toBe(false);
          expect(withoutRequest.timers.timeouts).toHaveLength(1);
          withoutRequest.scheduler.stop();
        });
      });

      it('defers a request made synchronously inside runCycle, so no timer runs during the cycle', async () => {
        const running = deferred();
        const { timers, calls, scheduler } = requestingScheduler((requestContinuation) => {
          requestContinuation();
          return running.promise;
        });
        const cycle = scheduler.runCycle();
        expect(timers.timeouts).toHaveLength(0);
        running.resolve({ priorityBacklog: false });
        await cycle;
        expect(timers.timeouts).toHaveLength(1);
        timers.timeouts[0].fn();
        await scheduler.waitForIdle();
        expect(calls).toEqual([{}, { continuation: true }]);
      });

      it('cancels a continuation created by a request when stopped before it fires', async () => {
        const { timers, calls, scheduler, request } = requestingScheduler();
        scheduler.start();
        timers.timeouts[0].fn();
        await scheduler.waitForIdle();
        request();
        expect(scheduler.hasPendingContinuation()).toBe(true);
        scheduler.stop();
        expect(timers.timeouts[1].cleared).toBe(true);
        timers.timeouts[1].fn();
        await scheduler.waitForIdle();
        expect(calls).toEqual([{}]);
      });

      it('ignores requests after stop, including one made by a cycle stopped while it ran', async () => {
        const running = deferred();
        const { timers, scheduler, request } = requestingScheduler(() => running.promise);
        scheduler.start();
        const cycle = scheduler.runCycle();
        scheduler.stop();
        request();
        running.resolve({ priorityBacklog: false });
        await cycle;
        request();
        expect(scheduler.hasPendingContinuation()).toBe(false);
        expect(timers.timeouts).toHaveLength(1);
      });
    });

    it('rejects a continuation delay that is not shorter than the interval', () => {
      expect(() => createReleaseNotificationScheduler({ runCycle: () => ({}), continuationDelayMs: 0 })).toThrow();
      expect(() => createReleaseNotificationScheduler({
        runCycle: () => ({}), continuationDelayMs: RELEASE_NOTIFICATION_CYCLE_INTERVAL_MS,
      })).toThrow();
    });
  });
});
