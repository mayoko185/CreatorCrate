/**
 * Project ownership adoption lifecycle (PM-1C1).
 *
 * Binds projects that existed before PM-1B — a `projects` row and a stored
 * `project_dir`, but no `project_directory_ownership` row and no
 * `.creatorcrate-owner` marker — when their ownership can be proven from
 * existing installation evidence, and completes marker publications that an
 * earlier run left `pending`. Nothing else is repaired, rebound, or replaced;
 * explicit operator recovery is PM-1C2.
 *
 * Proof. The only accepted legacy fact is "the manifest's project ID equals
 * the SQLite project ID": a `project.json` that is a regular non-symlink file
 * directly inside the safely resolved stored project directory, parses and
 * validates under the established legacy manifest parser, and names this
 * project. Its other fields (possibly stale) are never read into SQLite, and
 * the file is never rewritten. Pathname, ID prefix, contents, timestamps, and
 * inode identity prove nothing on their own.
 *
 * Restart-safe binding, one project at a time, synchronously (so no request
 * or scan interleaves with a step):
 *
 *     establish proof → persist pending token → create marker exclusively
 *       (read back and verified) → mark exactly (project, token) bound
 *
 * An existing valid marker is never replaced: with proof and no row its token
 * is adopted (pending → re-verify → bound). A pending row whose marker already
 * carries its token is completed without re-reading the manifest — the token
 * is random and only this protocol writes it, so the marker at the safely
 * resolved stored path is the proof. A pending row without a marker publishes
 * the marker only after re-establishing the legacy proof. Anything malformed,
 * unsafe, or conflicting is left untouched and classified `recovery-required`.
 *
 * SMB. "Could not currently inspect" (unavailable root, I/O or permission
 * errors, a missing project directory) is never evidence: nothing is written,
 * the current row state is kept, the project is classified `retryable`, and
 * the pass moves on to the next project. Retryable projects are retried with a
 * bounded backoff timer, on `signal()`, and on every later startup.
 *
 * Lifecycle. `prepare()` runs synchronously right after migrations (and on
 * every database adoption); `signal()` runs the background work: the one-time
 * pass over SQLite projects in stable ID order up to a fixed upper bound
 * (committed cursor), then — on later runs — only the retryable set and any
 * unclassified pending rows. Bound projects are never revisited, so no
 * `project.json` is read for them again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readLegacyManifestEvidence } from '../storage/manifest.js';
import { resolveProjectDir, verifyProjectDirOwnership } from '../storage/project-storage.js';
import { StorageError } from '../storage/path-manager.js';
import {
  createProjectOwnershipMarker,
  generateProjectOwnershipToken,
  readProjectOwnershipMarker,
} from '../storage/project-ownership-marker.js';
import { ProjectOwnershipTokenConflictError } from '../data/project-directory-ownership-repository.js';

const MAX_RUNNER_RETRIES = 3;
const MAX_STEP_ATTEMPTS = 3;

/** Reasons a project needs explicit operator recovery (PM-1C2). */
export const PROJECT_OWNERSHIP_RECOVERY_REASONS = Object.freeze([
  'project-directory-invalid', // stored path not a safe direct child carrying the ID prefix
  'project-directory-unsafe', // symlink or non-directory at the stored path
  'manifest-missing', // no legacy project.json and no other approved proof
  'manifest-unsafe', // project.json is a symlink or non-regular entry
  'manifest-malformed', // unparsable, oversized, or failing validation
  'manifest-unsupported', // unsupported schema version
  'manifest-project-mismatch', // manifest names another project ID
  'marker-malformed', // unbound: marker content invalid (never overwritten)
  'marker-unsafe', // unbound: marker is a symlink or non-regular entry
  'marker-token-in-use', // unbound: marker token already bound to another project
  'marker-write-remnant', // a marker was exposed but not confirmed; it is kept
  'pending-marker-mismatch', // pending token X, marker carries Y
  'pending-marker-malformed', // pending, marker invalid (e.g. crash mid-write)
  'pending-marker-unsafe', // pending, marker is a symlink or non-regular entry
  'bound-marker-missing', // completed binding lost its marker
  'bound-marker-mismatch', // completed binding, marker carries another token
  'bound-marker-malformed',
  'bound-marker-unsafe',
  'binding-without-directory', // ownership row for a project with no stored directory
]);

/** Reasons a project is retried automatically. */
export const PROJECT_OWNERSHIP_RETRYABLE_REASONS = Object.freeze([
  'projects-root-unavailable',
  'project-directory-missing',
  'project-directory-unavailable',
  'marker-unavailable',
  'manifest-unavailable',
  'marker-write-failed',
  'state-changed',
  'inspection-failed',
  'classification-invalid',
]);

const retryable = (reason) => ({ outcome: 'retryable', classification: { status: 'retryable', reason } });
const recovery = (reason) => ({
  outcome: 'recoveryRequired', classification: { status: 'recovery-required', reason },
});
const AGAIN = Object.freeze({ again: true });

function isTransientMarker(result) {
  return result.status === 'unreadable'
    || (result.status === 'unsafe'
      && (result.reason === 'changed-during-read' || result.reason === 'project-directory-missing'));
}

/**
 * Resolve a project's stored directory with the same rules as the PM-1B
 * verifier (under PROJECTS_ROOT, direct child, no symlink component, project
 * ID prefix, real non-symlink directory), separating "unsafe/invalid"
 * (definitive, `recovery-required`) from "could not look" (transient,
 * `retryable`). Shared with explicit recovery (PM-1C2) so both apply
 * identical path rules. Never repairs anything.
 *
 * @returns {{ absPath: string } | { outcome: string, classification: { status: string, reason: string } }}
 */
export function inspectStoredProjectDirectory(projectsRoot, project) {
  const root = path.resolve(projectsRoot);
  try {
    if (!fs.statSync(root).isDirectory()) return retryable('projects-root-unavailable');
  } catch {
    return retryable('projects-root-unavailable');
  }
  let absPath;
  try {
    absPath = resolveProjectDir(root, project.project_dir);
  } catch (err) {
    // Classify from the resolver's own failure, never from a later look: a
    // path that is visible now does not make an earlier access failure
    // structural. Only a proven symlink or a lexical rule violation (outside
    // the root, nested, absolute, empty) is definitive.
    if (!(err instanceof StorageError) || err.code === 'PROJECT_PATH_UNAVAILABLE') {
      return retryable('project-directory-unavailable');
    }
    if (err.code === 'PROJECT_PATH_SYMLINK') return recovery('project-directory-unsafe');
    return recovery('project-directory-invalid');
  }
  if (!verifyProjectDirOwnership(absPath, project.id)) return recovery('project-directory-invalid');
  let stats;
  try {
    stats = fs.lstatSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return retryable('project-directory-missing');
    return retryable('project-directory-unavailable');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return recovery('project-directory-unsafe');
  return { absPath };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/project-ownership-adoption-repository.js').createProjectOwnershipAdoptionRepository>} deps.repository
 * @param {ReturnType<import('../data/project-directory-ownership-repository.js').createProjectDirectoryOwnershipRepository>} deps.ownershipRepository
 * @param {string} deps.projectsRoot
 */
export function createProjectOwnershipAdoptionService({
  repository, ownershipRepository, projectsRoot,
  maintenanceState = null, managedUploadTracker = null, applicationLogger = null,
  batchSize = 32,
  retryBaseDelayMs = 60_000,
  retryMaxDelayMs = 30 * 60_000,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  if (!repository || !ownershipRepository || !projectsRoot) {
    throw new Error('Project ownership adoption requires repository, ownership repository, and projects root dependencies.');
  }
  let stopped = false;
  let pauseCount = 0;
  let runner = null;
  let timer = null;
  let wakeRequested = false;
  let failureRetries = 0;
  let backoffAttempt = 0;

  const log = (level, event, message, extra = {}) => {
    try {
      applicationLogger?.[level]?.({ kind: 'diagnostic', subsystem: 'projects', event, message, ...extra });
    } catch { /* diagnostics never change lifecycle behavior */ }
  };

  const halted = () => stopped || pauseCount > 0 || Boolean(maintenanceState?.active);

  // ─── Inspection ──────────────────────────────────────────────────────

  // The one legacy fact: manifest project ID === SQLite project ID.
  function legacyProof(absPath, projectId) {
    const evidence = readLegacyManifestEvidence(absPath);
    switch (evidence.status) {
      case 'valid': return evidence.projectId === projectId ? null : recovery('manifest-project-mismatch');
      case 'missing': return recovery('manifest-missing');
      case 'unsafe': return recovery('manifest-unsafe');
      case 'unsupported': return recovery('manifest-unsupported');
      case 'malformed': return recovery('manifest-malformed');
      default: return retryable('manifest-unavailable');
    }
  }

  // Exclusively publish the marker for an already persisted pending token,
  // then bind exactly that token.
  function publishAndBind(projectId, absPath, token, outcome) {
    try {
      if (createProjectOwnershipMarker(absPath, token).status === 'exists') return AGAIN;
    } catch (err) {
      if (err.code === 'RECOVERY_REQUIRED') return recovery('marker-write-remnant');
      if (err.code === 'PROJECT_DIRECTORY_UNSAFE') return retryable('state-changed');
      return retryable('marker-write-failed');
    }
    return ownershipRepository.markBound(projectId, token) ? { outcome } : AGAIN;
  }

  function evaluateOnce(project) {
    const row = ownershipRepository.findByProjectId(project.id);
    if (project.project_dir == null) {
      // DB-only project: no directory, so no ownership binding is required.
      return row ? recovery('binding-without-directory') : { outcome: 'notRequired' };
    }
    const dir = inspectStoredProjectDirectory(projectsRoot, project);
    if (!dir.absPath) return dir;
    const { absPath } = dir;
    const marker = readProjectOwnershipMarker(absPath);
    if (isTransientMarker(marker)) return retryable('marker-unavailable');

    if (row?.state === 'bound') {
      // A completed binding is never repaired here.
      if (marker.status === 'valid') {
        return marker.token === row.token ? { outcome: 'bound' } : recovery('bound-marker-mismatch');
      }
      return recovery(`bound-marker-${marker.status}`);
    }

    if (row?.state === 'pending') {
      if (marker.status === 'valid') {
        if (marker.token !== row.token) return recovery('pending-marker-mismatch');
        // Crash after the marker was durably written: finish the binding.
        return ownershipRepository.markBound(project.id, row.token) ? { outcome: 'completed' } : AGAIN;
      }
      if (marker.status !== 'missing') return recovery(`pending-marker-${marker.status}`);
      // Crash before the marker: never publish on yesterday's pathname alone.
      const problem = legacyProof(absPath, project.id);
      if (problem) return problem;
      return publishAndBind(project.id, absPath, row.token, 'completed');
    }

    // No ownership row.
    if (marker.status === 'malformed' || marker.status === 'unsafe') return recovery(`marker-${marker.status}`);
    const problem = legacyProof(absPath, project.id);
    if (problem) return problem;

    if (marker.status === 'valid') {
      // A marker newer than this database (e.g. an older DB restored): keep
      // its token and adopt it through the same pending → bound sequence.
      try {
        if (!ownershipRepository.createPending(project.id, marker.token)) return AGAIN;
      } catch (err) {
        if (err instanceof ProjectOwnershipTokenConflictError) return recovery('marker-token-in-use');
        throw err;
      }
      const check = readProjectOwnershipMarker(absPath);
      if (check.status !== 'valid' || check.token !== marker.token) return AGAIN;
      return ownershipRepository.markBound(project.id, marker.token) ? { outcome: 'adopted' } : AGAIN;
    }

    const token = generateProjectOwnershipToken();
    try {
      if (!ownershipRepository.createPending(project.id, token)) return AGAIN;
    } catch (err) {
      if (err instanceof ProjectOwnershipTokenConflictError) return retryable('state-changed');
      throw err;
    }
    return publishAndBind(project.id, absPath, token, 'adopted');
  }

  /**
   * Decide one project. Synchronous from first read to last write.
   * @returns {{ outcome: string, classification?: { status, reason } }}
   */
  function evaluate(project) {
    for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt++) {
      let result;
      try {
        result = evaluateOnce(project);
      } catch (error) {
        log('error', 'projects.ownership.adoption_failed', 'Project ownership adoption step failed.',
          { error, projectId: project.id });
        return retryable('inspection-failed');
      }
      if (!result.again) return result;
    }
    return retryable('state-changed');
  }

  function logDecision(projectId, result) {
    if (result.outcome === 'adopted' || result.outcome === 'completed') {
      log('info', 'projects.ownership.adopted', 'Project directory ownership established.',
        { projectId, context: { outcome: result.outcome } });
    } else if (result.classification) {
      log(result.outcome === 'retryable' ? 'warn' : 'error', 'projects.ownership.unresolved',
        'Project directory ownership could not be established automatically.',
        { projectId, context: { ...result.classification } });
    }
  }

  // ─── Runs ────────────────────────────────────────────────────────────

  // One step under a tracker lifetime, so replacement maintenance cannot
  // retire this database mid-step. Returns false when the run must stop.
  function withStep(fn) {
    if (halted()) return false;
    const lifetime = managedUploadTracker ? managedUploadTracker.begin() : { complete() {} };
    if (!lifetime) return false;
    try { fn(); } finally { lifetime.complete(); }
    return true;
  }

  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

  async function runInitialPass() {
    let record = repository.get();
    while (record?.phase === 'running') {
      const page = repository.page(record.cursor, record.upperBound, batchSize);
      if (!page.length) {
        if (!withStep(() => { record = repository.complete(); })) return false;
        log('info', 'projects.ownership.adoption_pass_completed',
          'Project ownership adoption pass completed.', { context: { counts: record.counts } });
        break;
      }
      for (const project of page) {
        const ok = withStep(() => {
          const result = evaluate(project);
          record = repository.commitStep(project.id, result.outcome, result.classification ?? null)
            ?? repository.get();
          logDecision(project.id, result);
        });
        if (!ok) return false;
        await yieldToEventLoop();
      }
    }
    return true;
  }

  // Projects a later run looks at: the retryable set, plus any pending row
  // not already classified for explicit recovery. Never bound projects.
  function retryCandidates() {
    const classifications = new Map(repository.listClassifications().map((entry) => [entry.projectId, entry]));
    const ids = new Set();
    for (const entry of classifications.values()) if (entry.status === 'retryable') ids.add(entry.projectId);
    for (const row of ownershipRepository.listPending()) {
      if (classifications.get(row.projectId)?.status !== 'recovery-required') ids.add(row.projectId);
    }
    return [...ids].sort((a, b) => a - b);
  }

  async function runRetries() {
    for (const projectId of retryCandidates()) {
      const ok = withStep(() => {
        const project = repository.findProject(projectId);
        if (!project) { repository.setClassification(projectId, null); return; }
        const result = evaluate(project);
        repository.setClassification(projectId, result.classification ?? null);
        logDecision(projectId, result);
      });
      if (!ok) return false;
      await yieldToEventLoop();
    }
    return true;
  }

  function hasRetryable() {
    return repository.listClassifications().some((entry) => entry.status === 'retryable');
  }

  async function run() {
    const record = repository.get();
    const finished = record?.phase === 'running' ? await runInitialPass() : await runRetries();
    return finished;
  }

  function scheduleTimer(delay) {
    if (stopped || pauseCount || timer) return;
    timer = schedule(() => { timer = null; signal(); }, delay);
    timer?.unref?.();
  }

  // Bounded, non-busy backoff while transiently unavailable projects remain.
  function scheduleRetry() {
    if (!hasRetryable()) { backoffAttempt = 0; return; }
    const delay = Math.min(retryBaseDelayMs * 2 ** backoffAttempt, retryMaxDelayMs);
    backoffAttempt = Math.min(backoffAttempt + 1, 30);
    scheduleTimer(delay);
  }

  /** Run pending adoption work in the background (coalesced). */
  function signal() {
    if (halted()) return;
    if (runner) { wakeRequested = true; return; }
    if (timer) { cancel(timer); timer = null; }
    let failed = false;
    let finished = false;
    runner = Promise.resolve().then(run).then((result) => { finished = result; failureRetries = 0; }, (error) => {
      failed = true;
      log('error', 'projects.ownership.adoption_lifecycle_failed', 'Project ownership adoption paused.', { error });
    }).finally(() => {
      runner = null;
      if (halted()) return;
      if (wakeRequested) { wakeRequested = false; signal(); return; }
      if (failed) {
        if (++failureRetries <= MAX_RUNNER_RETRIES) scheduleTimer(250 * 2 ** (failureRetries - 1));
        return;
      }
      if (!finished) { scheduleTimer(250); return; }
      try { scheduleRetry(); } catch { /* the next startup or signal retries */ }
    });
  }

  /** Synchronous startup/adoption step: create or load the lifecycle record. */
  function prepare() {
    repository.initialize();
    repository.pruneDeleted();
    return readiness();
  }

  function readiness() {
    let record = null;
    try { record = repository.get(); } catch { /* reported as not complete */ }
    const unresolved = repository.listClassifications();
    return {
      initialPassComplete: record?.phase === 'completed',
      pass: record ? {
        phase: record.phase, cursor: record.cursor, upperBound: record.upperBound, counts: { ...record.counts },
      } : null,
      retryable: unresolved.filter((entry) => entry.status === 'retryable').length,
      recoveryRequired: unresolved.filter((entry) => entry.status === 'recovery-required').length,
    };
  }

  /**
   * Ownership state of one project, for diagnostics and PM-1C2:
   *   - `bound`: bound row (the PM-1B verifier still checks the marker on use);
   *   - `not-required`: DB-only project with no stored directory;
   *   - `awaiting-adoption`: not yet reached by the initial pass;
   *   - `pending`: an unfinished binding the next run will try to complete;
   *   - `retryable`: could not currently inspect; retried automatically;
   *   - `recovery-required`: needs explicit recovery (`reason` says why);
   *   - `unbound`: no binding and no classification.
   * Never contains a filesystem path. Null for an unknown project.
   */
  function getProjectStatus(projectId) {
    const project = repository.findProject(projectId);
    if (!project) return null;
    const row = ownershipRepository.findByProjectId(projectId);
    const classification = repository.getClassification(projectId);
    const binding = row?.state ?? null;
    if (classification) {
      return { projectId, state: classification.status, reason: classification.reason, binding };
    }
    if (binding === 'bound') return { projectId, state: 'bound', reason: null, binding };
    if (binding === 'pending') return { projectId, state: 'pending', reason: null, binding };
    if (project.project_dir == null) return { projectId, state: 'not-required', reason: null, binding };
    let record = null;
    try { record = repository.get(); } catch { /* treated as awaiting */ }
    if (!record || (record.phase === 'running' && projectId > record.cursor && projectId <= record.upperBound)) {
      return { projectId, state: 'awaiting-adoption', reason: null, binding };
    }
    return { projectId, state: 'unbound', reason: null, binding };
  }

  /** Every unresolved project, in project-ID order (no paths). */
  function listUnresolved() {
    return repository.listClassifications().map((entry) => ({
      projectId: entry.projectId, state: entry.status, reason: entry.reason,
      binding: ownershipRepository.findByProjectId(entry.projectId)?.state ?? null,
    }));
  }

  return {
    prepare,
    signal,
    readiness,
    getProjectStatus,
    listUnresolved,
    /** True once every project of the one-time pass was classified. */
    isInitialPassComplete: () => repository.isInitialPassComplete(),
    pauseForMaintenance() {
      pauseCount++;
      if (timer) { cancel(timer); timer = null; }
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
      if (timer) { cancel(timer); timer = null; }
    },
    waitForIdle() { return runner ?? Promise.resolve(); },
  };
}
