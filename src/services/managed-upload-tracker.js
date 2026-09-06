/** Process-local authority: cancellation never releases operation ownership. */
export function createManagedUploadTracker() {
  const active = new Set();
  let owner = null;
  let shutdownClosed = false;
  const idleWaiters = new Set();
  let legacyClosures = 0;
  const states = new WeakSet();
  const maintenanceOwners = new WeakMap();
  const admissionClosed = () => shutdownClosed || owner !== null || legacyClosures > 0;
  return Object.freeze({
    // Compatibility for legacy maintenance callers. Boolean writes cannot
    // release replacement's token ownership.
    bindMaintenanceState(state) {
      if (states.has(state)) return;
      let legacyActive = Boolean(state.active);
      Object.defineProperty(state, 'active', {
        enumerable: true,
        configurable: false,
        get: admissionClosed,
        set(value) {
          const next = Boolean(value);
          if (next !== legacyActive) legacyClosures += next ? 1 : -1;
          legacyActive = next;
        },
      });
      if (legacyActive) legacyClosures++;
      states.add(state);
    },
    tryBeginMaintenance(binding) {
      if (admissionClosed() || active.size > 0) return null;
      const boundDb = binding?.db;
      const isCurrent = binding?.isCurrent;
      const boundGraph = binding?.graph;
      const identity = {};
      owner = identity;
      const capability = Object.freeze({
        assertCanRetire(db, graph = boundGraph) {
          if (owner !== identity || !isCurrent || boundDb !== db || graph !== boundGraph || !isCurrent()) {
            throw new Error('Replacement maintenance ownership is not current.');
          }
        },
        release() {
          if (owner !== identity) return false;
          owner = null;
          return true;
        },
      });
      maintenanceOwners.set(capability, capability.assertCanRetire);
      return capability;
    },
    assertMaintenanceOwner(capability, db, graph) {
      const validate = maintenanceOwners.get(capability);
      if (!validate) throw new Error('Replacement maintenance ownership is required.');
      validate(db, graph);
    },
    beginShutdown() { shutdownClosed = true; },
    waitForIdle() {
      if (active.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    begin() {
      if (admissionClosed()) return null;
      const controller = new AbortController();
      const identity = {};
      active.add(identity);
      return Object.freeze({
        signal: controller.signal,
        cancel() {
          if (active.has(identity)) controller.abort();
        },
        complete() {
          if (!active.delete(identity) || active.size !== 0) return;
          const waiters = [...idleWaiters];
          idleWaiters.clear();
          for (const resolve of waiters) resolve();
        },
      });
    },
    hasActive() { return active.size > 0; },
    get activeCount() { return active.size; },
  });
}

// Not tied to a database/application context; replacement must retain this authority.
export const managedUploadTracker = createManagedUploadTracker();

// Acquisition and the existing processing guard run synchronously, with upload
// admission closed before processing is inspected. This is not a processing
// submission admission gate.
export function beginReplacementMaintenance(db, isCurrent, assertNoActiveProcessingJobs, graph) {
  const owner = managedUploadTracker.tryBeginMaintenance({ db, isCurrent, graph });
  if (!owner) throw new Error('Cannot replace the application context while managed uploads or maintenance are active.');
  try {
    owner.assertCanRetire(db);
    assertNoActiveProcessingJobs?.();
    return owner;
  } catch (error) {
    owner.release();
    throw error;
  }
}
