import { randomUUID } from 'node:crypto';
import { InvalidGeneratedImageRebuildRecordError } from '../data/generated-image-rebuild-repository.js';
import { projectImageRebuildScope } from './project-image-policy.js';
import { validateProjectImageSetting } from './project-image-settings-service.js';

const ACTIVE_PHASES = new Set(['queued', 'running']);
const MAX_RUNNER_RETRIES = 3;
const RECORD_PHASES = new Set([...ACTIVE_PHASES, 'completed', 'completed_with_failures', 'failed']);
const POLICY_FIELDS = [
  ['thumbnail', 'format', 'thumbnailFormat'],
  ['thumbnail', 'webpQuality', 'thumbnailWebpQuality'],
  ['thumbnail', 'maxDimension', 'thumbnailMaxDimension'],
  ['preview', 'format', 'previewFormat'],
  ['preview', 'webpQuality', 'previewWebpQuality'],
  ['preview', 'maxDimension', 'previewMaxDimension'],
];
const EXAMPLES = [
  { extension: 'png', source_animated: 0 },
  { extension: 'gif', source_animated: 1 },
  { extension: 'webp', source_animated: 0 },
  { extension: 'kra', source_animated: 0 },
];

export function effectiveProjectImagePolicyChanged(previous, target) {
  return EXAMPLES.some((asset) => projectImageRebuildScope(previous, target, asset).needsRebuild);
}

function validPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
  return POLICY_FIELDS.every(([group, field, setting]) => {
    const value = policy[group]?.[field];
    try { return validateProjectImageSetting(setting, value) === value; } catch { return false; }
  });
}

function trustedRecord(record) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  return record && typeof record.runId === 'string' && record.runId.length > 0
    && ['automatic', 'manual'].includes(record.mode) && RECORD_PHASES.has(record.phase)
    && validPolicy(record.targetPolicy)
    && (record.previousPolicy === null || validPolicy(record.previousPolicy))
    && typeof record.reconcileAll === 'boolean'
    && ['cursor', 'upperBound', 'total', 'attempted', 'succeeded', 'failed', 'skipped']
      .every((field) => count(record[field]))
    && record.cursor <= record.upperBound
    && Array.isArray(record.failures);
}

// The rebuild may keep B logical assets submitted but not yet checkpointed,
// where B leaves at least one of the C shared processing slots for other
// callers whenever C > 1. This is a submission reservation, not a priority:
// Preview Service still takes each actual permit from the one FIFO pool.
// B is capped at 2 because each rebuilt asset also does substantial
// synchronous cache/source work on the main thread; beyond two in flight
// that work, not Sharp, bounds throughput while foreground requests queue
// behind it.
export const MAX_BACKGROUND_REBUILD_WINDOW = 2;

export function backgroundRebuildWindow(capacity, maxWindow = MAX_BACKGROUND_REBUILD_WINDOW) {
  return Number.isInteger(capacity) && capacity > 1 ? Math.max(1, Math.min(capacity - 1, maxWindow)) : 1;
}

export function createGeneratedImageRebuildService({
  repository, imageSettings, previewService,
  maintenanceState, managedUploadTracker, applicationLogger,
  processingConcurrency = 1,
  // Only tests widen this to exercise the frontier with larger windows.
  maxBackgroundWindow = MAX_BACKGROUND_REBUILD_WINDOW,
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!repository || !imageSettings || !previewService
    || !maintenanceState || !managedUploadTracker) {
    throw new Error('Generated-image rebuild requires repository, settings, preview, and lifecycle dependencies.');
  }
  let stopped = false;
  let pauseCount = 0;
  let runner = null;
  let timer = null;
  let timerRunId = null;
  let retryRunId = null;
  let retryCount = 0;
  let exhaustedRunId = null;
  let wakeRequested = false;
  const windowSize = backgroundRebuildWindow(processingConcurrency, maxBackgroundWindow);

  function readStatus() {
    return repository.get() ?? {
      version: 1, phase: 'idle', mode: null, runId: null, targetPolicy: null,
      cursor: 0, upperBound: 0, total: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0,
      failures: [],
    };
  }

  function newRecord(mode, previousPolicy, targetPolicy, reconcileAll = false) {
    const { total, upperBound } = repository.bounds();
    return {
      version: 1, runId: randomUUID(), mode, phase: 'queued', previousPolicy, targetPolicy,
      reconcileAll, cursor: 0, upperBound, total,
      attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: [],
    };
  }

  // Called inside the same transaction that persists the new Settings values.
  function queueAutomatic(previousPolicy, targetPolicy) {
    const prior = repository.get();
    const unfinished = prior && (ACTIVE_PHASES.has(prior.phase)
      || (prior.mode === 'automatic' && prior.phase === 'failed' && prior.cursor < prior.upperBound));
    if (!unfinished && !effectiveProjectImagePolicyChanged(previousPolicy, targetPolicy)) return false;
    const baseline = unfinished && prior.mode === 'automatic' ? prior.previousPolicy : previousPolicy;
    // A started run may have published any dispatched asset, including ones
    // after its durable cursor, so its successor cannot trust `cursor > 0`.
    const reconcileAll = Boolean(unfinished && (prior.phase === 'failed' || prior.reconcileAll
      || prior.cursor > 0 || prior.phase === 'running' || prior.started === true));
    repository.save(newRecord('automatic', baseline, targetPolicy, reconcileAll));
    return true;
  }

  function queueManual() {
    repository.save(newRecord('manual', null, imageSettings.getPolicy()));
  }

  function recover({ restartAutomatic = true } = {}) {
    let record;
    try { record = repository.get(); } catch (error) {
      if (!(error instanceof InvalidGeneratedImageRebuildRecordError)) throw error;
      record = {};
    }
    if (record && !trustedRecord(record)) {
      repository.save(newRecord('automatic', null, imageSettings.getPolicy(), true));
      return;
    }
    if (!record || (!ACTIVE_PHASES.has(record.phase) && record.phase !== 'failed')) return;
    const savedPolicy = imageSettings.getPolicy();
    if (JSON.stringify(savedPolicy) !== JSON.stringify(record.targetPolicy)) {
      repository.save(newRecord('automatic', record.targetPolicy, savedPolicy, true));
      return;
    }
    if (record.phase === 'failed') {
      repository.save({ ...record, phase: 'queued', runnerError: null });
    } else if (record.mode === 'automatic' && restartAutomatic) {
      const { total, upperBound } = repository.bounds();
      repository.save({ ...record, phase: 'queued', cursor: 0, total, upperBound,
        attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: [] });
    } else {
      repository.save({ ...record, phase: 'queued' });
    }
  }

  function isCurrent(record) {
    const current = repository.get();
    return !stopped && current?.runId === record.runId
      && JSON.stringify(imageSettings.getPolicy()) === JSON.stringify(record.targetPolicy);
  }

  function saveIfCurrent(record) {
    if (!isCurrent(record)) return false;
    repository.save(record);
    return true;
  }

  function scheduleRetry() {
    if (stopped || pauseCount || timer) return;
    timerRunId = repository.get()?.runId;
    timer = schedule(() => { timer = null; timerRunId = null; signal(); }, 250);
    timer?.unref?.();
  }

  // Starts one logical asset. The returned entry settles (never rejects) and
  // records its terminal outcome; the durable effect is applied later, only
  // when the entry reaches the contiguous committed prefix of the window.
  function startAsset(record, asset, lifetime) {
    const entry = { asset, done: false, outcome: 'skipped', failure: null, faulted: false, fatal: null };
    // Authority reads are rebuild control, not asset work. The first read
    // that throws marks the entry fatal at once, so the window stops
    // refilling even while Preview Service is still pending or has absorbed
    // the error; it stays a runner fault however Preview rewraps it. A read
    // that succeeds and answers false is ordinary supersession.
    const markFatal = (error) => {
      if (!entry.faulted) { entry.faulted = true; entry.fatal = error; }
    };
    const authoritative = () => {
      try { return isCurrent(record); } catch (error) { markFatal(error); throw error; }
    };
    entry.settled = (async () => {
      let result = null;
      let failed = false;
      let assetError;
      try {
        const resolved = imageSettings.getPresentationPolicy(record.targetPolicy).resolveAsset(asset);
        const relevant = record.mode === 'manual' || record.reconcileAll
          || projectImageRebuildScope(record.previousPolicy, record.targetPolicy, resolved).needsRebuild;
        if (relevant && authoritative()) {
          // Preview Service admits actual generation through the shared
          // processing pool itself; holding a permit here would nest.
          result = await previewService.ensureTargetGeneration(
            asset.project_id, asset.id, record.targetPolicy, authoritative,
            { force: record.mode === 'manual' },
          );
        }
      } catch (error) {
        failed = true;
        assetError = error;
      }
      if (entry.faulted) return;
      if (!failed) {
        if (result) entry.outcome = result.cacheState === 'regenerated' ? 'succeeded' : 'skipped';
      } else if (authoritative()) {
        entry.outcome = 'failed';
        entry.failure = { assetId: asset.id, message: String(assetError?.message || assetError).slice(0, 180) };
      }
    })().catch(markFatal).finally(() => {
      lifetime.complete();
      entry.done = true;
    });
    return entry;
  }

  function applyOutcome(record, { asset, outcome, failure }) {
    return {
      ...record, cursor: asset.id,
      attempted: record.attempted + (outcome === 'skipped' ? 0 : 1),
      succeeded: record.succeeded + (outcome === 'succeeded' ? 1 : 0),
      failed: record.failed + (outcome === 'failed' ? 1 : 0),
      skipped: record.skipped + (outcome === 'skipped' ? 1 : 0),
      failures: failure && record.failures.length < 8 ? [...record.failures, failure] : record.failures,
    };
  }

  // Walks one run's keyset with at most `windowSize` dispatched but not yet
  // durably checkpointed assets. Entries finish out of order; the cursor and
  // counters advance only through the longest completed traversal prefix,
  // and a slot is refilled only after that prefix is persisted. Every exit
  // path drains the window first, so no dispatched asset outlives the runner.
  async function runWindow(initial) {
    let record = initial;
    const frontier = [];
    let buffer = [];
    let position = record.cursor;
    let exhausted = false;
    let halted = false;
    let retryLater = false;
    // A window fault (dispatch, checkpoint) stops every further checkpoint.
    // An entry's authority fault only stops refill: the prefix strictly
    // before that entry may still commit, never through it.
    let fatal = null;
    const fail = (error) => { if (!fatal) fatal = { error }; halted = true; };
    for (;;) {
      if (!fatal) {
        let count = 0;
        while (count < frontier.length && frontier[count].done && !frontier[count].faulted) count++;
        if (count) {
          const next = frontier.slice(0, count).reduce(applyOutcome, record);
          let saved = false;
          try { saved = saveIfCurrent(next); } catch (error) { fail(error); }
          if (saved) {
            record = next;
            frontier.splice(0, count);
            retryRunId = record.runId;
            retryCount = 0;
            await new Promise((resolve) => setImmediate(resolve));
            continue;
          }
          halted = true;
        }
      }
      // A faulted entry may still be pending: its fault is visible from the
      // moment the authority read threw, not from Preview settlement.
      if (frontier.some((entry) => entry.faulted)) halted = true;
      while (!halted && frontier.length < windowSize) {
        try {
          if (stopped || pauseCount || !isCurrent(record)) { halted = true; break; }
          if (maintenanceState.active) { halted = true; retryLater = true; break; }
          if (!buffer.length) {
            if (exhausted) break;
            buffer = repository.page(position, record.upperBound);
            if (!buffer.length) { exhausted = true; break; }
          }
          const lifetime = managedUploadTracker.begin();
          if (!lifetime) { halted = true; retryLater = true; break; }
          const asset = buffer.shift();
          position = asset.id;
          const entry = startAsset(record, asset, lifetime);
          frontier.push(entry);
          if (entry.faulted) halted = true;
        } catch (error) { fail(error); }
      }
      // Dispatch is synchronous, so every entry here settles after it; a
      // fully settled window was already committed above or cannot be.
      const pending = frontier.filter((entry) => !entry.done);
      if (!pending.length) break;
      await Promise.race(pending.map((entry) => entry.settled));
    }
    if (fatal) throw fatal.error;
    const broken = frontier.find((entry) => entry.faulted);
    if (broken) throw broken.fatal;
    if (retryLater) { scheduleRetry(); return false; }
    if (stopped || pauseCount) return false;
    if (!exhausted || frontier.length) return true;
    if (saveIfCurrent({ ...record, phase: record.failed ? 'completed_with_failures' : 'completed' })) {
      retryRunId = record.runId;
      retryCount = 0;
    }
    return true;
  }

  async function run(attempt) {
    while (!stopped && !pauseCount) {
      let record = repository.get();
      if (!record || !ACTIVE_PHASES.has(record.phase)) return;
      attempt.runId = record.runId;
      if (record.runId === exhaustedRunId) return;
      if (JSON.stringify(imageSettings.getPolicy()) !== JSON.stringify(record.targetPolicy)) return;
      if (maintenanceState.active) { scheduleRetry(); return; }
      if (record.phase === 'queued') {
        // `started` durably records that this run may publish assets ahead
        // of its checkpointed cursor, which a superseding run must reconcile.
        record = { ...record, phase: 'running', started: true };
        if (!saveIfCurrent(record)) continue;
      }
      if (!await runWindow(record)) return;
    }
  }

  function signal(force = false) {
    if (stopped || pauseCount) return;
    if (runner) { if (force) wakeRequested = true; return; }
    // One tracker lifetime spans the whole runner, not just its dispatched
    // assets: checkpoints, the terminal phase, and fault/retry handling all
    // still touch this graph's database after the last asset settles, so
    // replacement ownership must stay unavailable until the runner is done.
    // It is taken synchronously, before the runner can start any work.
    const lifetime = managedUploadTracker.begin();
    if (!lifetime) {
      try { scheduleRetry(); } catch (error) {
        applicationLogger?.error?.({ kind: 'diagnostic', subsystem: 'generated_images',
          event: 'generated_images.rebuild.failed', message: 'Could not read rebuild state while maintenance is active.', error });
      }
      return;
    }
    // Until the runner's `.finally()` is attached, this call owns the
    // lifetime: an early return (a pending retry already covers the run) or
    // a synchronous throw must release it here, exactly once.
    let transferred = false;
    try {
      if (timer) {
        if (!force && timerRunId === repository.get()?.runId) return;
        clearTimeout(timer);
        timer = null;
        timerRunId = null;
      }
      runner = startRunner(lifetime);
      transferred = true;
    } finally {
      if (!transferred) lifetime.complete();
    }
  }

  // Applies the bounded runner retry policy to one failed attempt and
  // reports whether it decided (retry or exhaustion). The decision never
  // needs the record: when it is unreadable the in-memory counter still
  // advances under the attempt's last known run, so a broken store spends
  // the same 250/500/1000 ms budget instead of stranding an active run.
  function retryRunner(error, { readable, current, knownRunId }) {
    if (stopped || pauseCount) return false;
    if (readable && !ACTIVE_PHASES.has(current?.phase)) return false;
    const runId = readable ? current.runId : knownRunId ?? retryRunId;
    if (retryRunId !== runId) { retryRunId = runId; retryCount = 0; }
    if (++retryCount <= MAX_RUNNER_RETRIES) {
      // One failed attempt leaves exactly one timer, whatever else queued.
      if (timer) clearTimeout(timer);
      timerRunId = runId;
      timer = schedule(() => { timer = null; timerRunId = null; signal(); }, 250 * 2 ** (retryCount - 1));
      timer?.unref?.();
      return true;
    }
    exhaustedRunId = runId;
    if (!readable) {
      applicationLogger?.error?.({ kind: 'diagnostic', subsystem: 'generated_images',
        event: 'generated_images.rebuild.failed',
        message: 'Generated-image rebuild exhausted retries; could not read state to persist failed state.', error });
      return true;
    }
    try {
      repository.save({ ...current, phase: 'failed', runnerError: String(error?.message || error).slice(0, 180) });
    } catch (saveError) {
      applicationLogger?.error?.({ kind: 'diagnostic', subsystem: 'generated_images',
        event: 'generated_images.rebuild.failed',
        message: 'Generated-image rebuild exhausted retries; could not persist failed state.', error: saveError });
    }
    return true;
  }

  // Returns the runner with its lifetime-completing `.finally()` attached.
  function startRunner(lifetime) {
    const attempt = { runId: null };
    let retryDecided = false;
    return Promise.resolve().then(() => run(attempt)).catch((error) => {
      applicationLogger?.error?.({ kind: 'diagnostic', subsystem: 'generated_images',
        event: 'generated_images.rebuild.failed', message: 'Generated-image rebuild paused.', error });
      let current;
      let readable = true;
      try { current = repository.get(); } catch (readError) {
        readable = false;
        applicationLogger?.error?.({ kind: 'diagnostic', subsystem: 'generated_images',
          event: 'generated_images.rebuild.failed', message: 'Could not read rebuild state after runner failure.', error: readError });
      }
      // The original fault stays the runner error; a failed recovery read
      // only means the retry decision proceeds without the record.
      retryDecided = retryRunner(error, { readable, current, knownRunId: attempt.runId });
    }).finally(() => {
      try {
        runner = null;
        // A woken successor takes its own lifetime before this one ends.
        if (wakeRequested) { wakeRequested = false; signal(true); return; }
        if (!stopped && !pauseCount && !maintenanceState.active && !timer && !retryDecided) {
          try {
            const current = repository.get();
            if (current?.runId !== exhaustedRunId && ACTIVE_PHASES.has(current?.phase)
              && JSON.stringify(imageSettings.getPolicy()) === JSON.stringify(current.targetPolicy)) scheduleRetry();
          } catch (error) {
            applicationLogger?.error?.({ kind: 'diagnostic', subsystem: 'generated_images',
              event: 'generated_images.rebuild.failed', message: 'Could not read rebuild state after runner stopped.', error });
            // An unreadable store is itself a control fault: it enters the
            // same bounded policy rather than leaving an active run stranded.
            retryRunner(error, { readable: false, knownRunId: attempt.runId });
          }
        }
      } finally {
        // A pending retry timer is not covered: replacement pauses the
        // service first, which cancels it, and stops the old service.
        lifetime.complete();
      }
    });
  }

  return {
    readStatus, queueAutomatic, queueManual, recover, signal,
    pauseForMaintenance() {
      pauseCount++;
      if (timer) clearTimeout(timer);
      timer = null;
      timerRunId = null;
      let released = false;
      return {
        waitForIdle: () => runner ?? Promise.resolve(),
        release() {
          if (released) return;
          released = true;
          pauseCount--;
          if (!pauseCount) signal();
        },
      };
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      timerRunId = null;
    },
    waitForIdle() { return runner ?? Promise.resolve(); },
  };
}
