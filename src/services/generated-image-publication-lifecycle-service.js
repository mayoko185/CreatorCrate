import { InvalidGeneratedImagePublicationError } from '../data/generated-image-publication-repository.js';

const MAX_RUNNER_RETRIES = 3;

/**
 * Generated-image publication lifecycle — makes the normalized SQLite
 * publication tables a trustworthy index: the committed snapshot is the
 * normal runtime authority every reader resolves (never current.json or
 * meta.json), and until `isPublicationIndexReady()` a presentation request
 * for an asset without a committed row is refused as not ready. This
 * service never serves a request and no request path calls it; it alone
 * reads the filesystem publication JSON (backfill and intent recovery).
 *
 * Startup (and every database adoption) calls `prepare()` synchronously,
 * right after migrations and rebuild-record recovery and before the graph
 * serves requests:
 *   - the lifecycle record is initialized: an install without one starts the
 *     one-time upgrade backfill; a restored database already carries its
 *     'restore' record (no legacy import); an untrusted record becomes a
 *     regeneration record;
 *   - every unresolved publication intent (`listIntents()`) is taken as the
 *     recovery set. While an intent exists the writer refuses to publish that
 *     asset ('pending'), so recovery owns it; other assets are unaffected;
 *   - a durable repair need on a completed record is admitted to the
 *     existing generated-image rebuild service.
 *
 * `signal()` then runs the background work, in order: targeted recovery of
 * the recovery set (re-read from the intent table), the remaining upgrade
 * backfill (bounded, restart-safe, resumed from its committed cursor), and
 * repair admission. Preview Service also signals it when a writer meets a
 * journal error, so an intent left behind in-process is recovered in the
 * background without a restart; the failing request itself recovers nothing. Once the record
 * is 'completed' an ordinary restart does no filesystem publication scan.
 *
 * All filesystem inspection happens in Preview Service helpers under the
 * per-asset lock; every durable decision is one SQLite transaction here.
 */
export function createGeneratedImagePublicationLifecycleService({
  repository, publications, previewService, rebuildService = null,
  maintenanceState = null, managedUploadTracker, applicationLogger = null,
  batchSize = 32,
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!repository || !publications || !previewService || !managedUploadTracker) {
    throw new Error('Generated-image publication lifecycle requires repository, publication, preview, and lifecycle dependencies.');
  }
  let stopped = false;
  let pauseCount = 0;
  let runner = null;
  let timer = null;
  let retryCount = 0;
  let wakeRequested = false;
  // assetId → { intent, status: 'pending'|'retained'|'resolved', outcome, reason }
  const recovery = new Map();

  const log = (level, event, message, extra = {}) => {
    try {
      applicationLogger?.[level]?.({ kind: 'diagnostic', subsystem: 'generated_images', event, message, ...extra });
    } catch { /* diagnostics never change lifecycle behavior */ }
  };

  const halted = () => stopped || pauseCount > 0 || Boolean(maintenanceState?.active);

  function readRecord() {
    try { return repository.get(); } catch { return null; }
  }

  /**
   * Admit a durable repair need to the existing rebuild machinery, but only
   * once the publication index is complete: before that, a missing row only
   * means "not imported yet". The rebuild record and the cleared need are
   * written in one transaction, so a crash can only repeat the admission.
   * A 'deferred' admission (a started manual run) keeps the need; the rebuild
   * service's `onRunTerminal` signals this service when that run ends, and
   * the run's final step admits it again.
   */
  function admitRepair({ signalRebuild = false } = {}) {
    const record = readRecord();
    if (!record || record.phase !== 'completed' || !record.repairRequired || !rebuildService?.queueRepair) {
      return null;
    }
    const result = repository.transaction(() => {
      const outcome = rebuildService.queueRepair();
      if (outcome !== 'deferred') repository.clearRepairRequired();
      return outcome;
    });
    if (signalRebuild && result === 'queued') rebuildService.signal?.();
    log('info', 'generated_images.publication.repair_admitted', 'Generated-image publication repair admitted.',
      { context: { outcome: result } });
    return result;
  }

  // The recovery set is always the intent table itself. Re-reading it is
  // safe while a writer is live: a writer holds the asset lock from intent
  // acquisition to finalization, and recovery re-checks ownership under that
  // same lock, so it only ever decides an intent no writer still owns.
  function refreshRecoverySet() {
    const intents = publications.listIntents();
    const listed = new Set();
    for (const intent of intents) {
      listed.add(intent.assetId);
      recovery.set(intent.assetId, { intent, status: 'pending', outcome: null, reason: null });
    }
    for (const [assetId, entry] of recovery) {
      if (!listed.has(assetId)) entry.status = 'resolved';
    }
  }

  /** Synchronous startup/adoption step; see the module comment. */
  function prepare() {
    repository.initialize();
    recovery.clear();
    refreshRecoverySet();
    admitRepair();
    return readiness();
  }

  function readiness() {
    const record = readRecord();
    const unresolved = [...recovery.entries()]
      .filter(([, entry]) => entry.status !== 'resolved').map(([assetId]) => assetId);
    return {
      publicationIndexReady: record?.phase === 'completed',
      backfill: record ? {
        mode: record.mode, phase: record.phase, cursor: record.cursor, upperBound: record.upperBound,
        repairRequired: record.repairRequired, counts: { ...record.counts },
      } : null,
      recovery: {
        unresolvedAssetIds: unresolved,
        retained: [...recovery.entries()].filter(([, entry]) => entry.status === 'retained')
          .map(([assetId, entry]) => ({ assetId, reason: entry.reason })),
      },
    };
  }

  // One intent, under the asset lock: Preview Service inspects, this commits.
  function recoverIntent(intent) {
    return previewService.withPublicationLock(intent.projectId, intent.assetId, async () => {
      const decision = await previewService.inspectPublicationIntent(intent);
      const abandon = (reason) => {
        const cleared = repository.transaction(() => {
          const removed = publications.clearIntent(intent.projectId, intent.assetId, intent.intentId);
          if (removed) repository.markRepairRequired();
          return removed;
        });
        return cleared ? { outcome: 'abandoned', reason } : { outcome: 'superseded' };
      };
      switch (decision.action) {
        case 'finalize': {
          let finalized;
          try {
            finalized = publications.finalizePublication(intent.intentId, decision.snapshot);
          } catch (error) {
            if (error instanceof InvalidGeneratedImagePublicationError) return abandon('candidate-mismatch');
            throw error;
          }
          return { outcome: finalized ? 'finalized' : 'superseded' };
        }
        case 'revert': {
          previewService.removeIntentRemnants(intent);
          const cleared = publications.clearIntent(intent.projectId, intent.assetId, intent.intentId);
          return { outcome: cleared ? 'reverted' : 'superseded' };
        }
        case 'abandon': return abandon(decision.reason);
        case 'retain': return { outcome: 'retained', reason: decision.reason };
        default: return { outcome: 'superseded' };
      }
    });
  }

  async function runRecovery() {
    for (const [assetId, entry] of [...recovery.entries()]) {
      if (halted()) return false;
      if (entry.status === 'resolved') continue;
      let result;
      try {
        result = await recoverIntent(entry.intent);
      } catch (error) {
        // One broken intent never blocks the others; it stays owned by
        // recovery and is retried on the next run.
        log('error', 'generated_images.publication.recovery_failed',
          'Generated-image publication intent recovery failed.', { error, context: { assetId } });
        result = { outcome: 'retained', reason: 'error' };
      }
      entry.outcome = result.outcome;
      entry.reason = result.reason ?? null;
      entry.status = result.outcome === 'retained' ? 'retained' : 'resolved';
      if (result.outcome !== 'finalized' && result.outcome !== 'superseded') {
        log(result.outcome === 'retained' ? 'warn' : 'info', 'generated_images.publication.recovered',
          'Generated-image publication intent recovered.', { context: { assetId, ...result } });
      }
    }
    return true;
  }

  async function backfillAsset(asset) {
    return previewService.withPublicationLock(asset.project_id, asset.id, async () => {
      const record = repository.get();
      if (!record || record.phase !== 'running' || asset.id <= record.cursor) return record;
      // A committed publication or an unresolved intent already decides the
      // asset: skip the filesystem entirely.
      if (publications.findPublication(asset.project_id, asset.id)) {
        return repository.commitStep(asset.id, 'alreadyPublished');
      }
      if (publications.findIntent(asset.project_id, asset.id)) {
        return repository.commitStep(asset.id, 'recoveryPending');
      }
      const inspection = await previewService.inspectLegacyPublication(asset.project_id, asset.id);
      return repository.commitStep(asset.id, inspection.outcome, inspection.snapshot
        ? () => publications.installPublication(inspection.snapshot) : null);
    });
  }

  async function runBackfill() {
    let record = repository.get();
    while (record?.mode === 'upgrade' && record.phase === 'running') {
      if (halted()) return false;
      const page = repository.page(record.cursor, record.upperBound, batchSize);
      if (!page.length) {
        record = repository.complete();
        log('info', 'generated_images.publication.backfill_completed',
          'Generated-image publication backfill completed.', { context: { counts: record.counts } });
        break;
      }
      for (const asset of page) {
        if (halted()) return false;
        record = (await backfillAsset(asset)) ?? repository.get();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return true;
  }

  async function run() {
    refreshRecoverySet();
    if (!await runRecovery()) return;
    if (!await runBackfill()) return;
    admitRepair({ signalRebuild: true });
  }

  function scheduleRetry(delay) {
    if (stopped || pauseCount || timer) return;
    timer = schedule(() => { timer = null; signal(); }, delay);
    timer?.unref?.();
  }

  function signal() {
    if (stopped || pauseCount) return;
    if (runner) { wakeRequested = true; return; }
    // Like the rebuild runner, one tracker lifetime spans the whole run so
    // replacement maintenance cannot retire this database underneath it.
    const lifetime = managedUploadTracker.begin();
    if (!lifetime) { scheduleRetry(250); return; }
    let failed = false;
    runner = Promise.resolve().then(run).then(() => { retryCount = 0; }, (error) => {
      failed = true;
      log('error', 'generated_images.publication.lifecycle_failed',
        'Generated-image publication lifecycle paused.', { error });
    }).finally(() => {
      runner = null;
      lifetime.complete();
      if (wakeRequested) { wakeRequested = false; signal(); return; }
      if (failed && ++retryCount <= MAX_RUNNER_RETRIES) scheduleRetry(250 * 2 ** (retryCount - 1));
    });
  }

  return {
    prepare,
    signal,
    readiness,
    /** True once the one-time backfill (or restore reset) has completed. */
    isPublicationIndexReady: () => repository.isPublicationIndexReady(),
    /** False only while an unresolved intent for the asset awaits recovery. */
    isAssetRecoverySettled: (assetId) => (recovery.get(assetId)?.status ?? 'resolved') === 'resolved',
    /**
     * Explicit repair admission for a known missing/invalid derived
     * publication. The need is persisted first, then admitted when the index
     * is complete. Request paths do not call it: they republish a missing or
     * damaged committed pair themselves through the journaling writer.
     */
    requestRepair() {
      repository.markRepairRequired();
      return admitRepair({ signalRebuild: true });
    },
    pauseForMaintenance() {
      pauseCount++;
      if (timer) clearTimeout(timer);
      timer = null;
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
    },
    waitForIdle() { return runner ?? Promise.resolve(); },
  };
}
