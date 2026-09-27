/**
 * Legacy `project.json` cleanup lifecycle (PM-2).
 *
 * CreatorCrate no longer creates, reads, or writes `project.json`: SQLite is
 * business authority and `.creatorcrate-owner` + the SQLite token is
 * filesystem ownership authority. Existing installations may still carry
 * historical manifests. This lifecycle removes only those it can prove are
 * obsolete duplicates; anything else is retained and reported. "SQLite is
 * authoritative now" is never, on its own, a reason to delete.
 *
 * Proof required before any deletion, per project and per file:
 *   1. the project exists in SQLite and has a stored directory;
 *   2. its `project_directory_ownership` row is `bound`, and neither PM-1C1
 *      adoption nor PM-1C2 recovery holds a classification for it;
 *   3. the stored directory passes the canonical path rules and its
 *      `.creatorcrate-owner` marker matches the SQLite token;
 *   4. the candidate is one of the exact recognized names directly in that
 *      root (see legacy-manifest-cleanup.js), a regular non-symlink file;
 *   5. its bytes are strict UTF-8, parse and validate as a schema-3 legacy
 *      manifest, name this project's ID, and are exactly the snapshot the
 *      legacy serializer would produce for the current SQLite row and
 *      categories (`describeLegacyManifestDivergence`);
 *   6. ownership is re-verified immediately before removal, and the entry
 *      removed is proven (content fingerprint, plus file identity where the
 *      filesystem reports one) to be the entry inspected.
 * Divergent, malformed, unsupported, mismatched, unsafe, or unreadable files
 * are never overwritten, imported, or deleted.
 *
 * Execution. Driven by SQLite projects in stable ID order up to a fixed upper
 * bound (committed cursor in `app_meta`), never by directory enumeration: a
 * directory without a DB project is never touched. One project per step,
 * synchronously, under the project's operation lock, so no scan, mutation, or
 * explicit recovery of that project interleaves. After the one-time pass only
 * projects classified `retryable` or `ownership-not-ready` are revisited, with
 * a bounded non-busy backoff; `retained` is terminal. The pass waits until
 * PM-1C1 adoption has finished its own one-time pass.
 *
 * SMB. "Could not look" (unavailable root, EIO, permissions, a file that
 * changed while read) is never evidence: the file is retained, the project is
 * classified `retryable`, and the pass continues with the next project.
 * Cleanup is maintenance; nothing in normal operation waits for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  describeLegacyManifestDivergence,
  parseLegacyManifestContent,
} from '../storage/manifest.js';
import {
  inspectLegacyManifestEntry,
  legacyManifestCandidateKind,
  removeProvenLegacyManifestEntry,
} from '../storage/legacy-manifest-cleanup.js';
import { readProjectOwnershipMarker } from '../storage/project-ownership-marker.js';
import { inspectStoredProjectDirectory } from './project-ownership-adoption-service.js';
import { ProjectOperationError } from './project-operation-coordinator.js';

const MAX_RUNNER_RETRIES = 3;
/** Recognized candidates handled per project per step; more are retained. */
const MAX_CANDIDATES = 32;
const KIND_ORDER = { manifest: 0, temp: 1, quarantine: 2 };

/** Dry-run / status classes, highest priority first. */
export const LEGACY_MANIFEST_CLEANUP_CLASSES = Object.freeze([
  'retry',
  'ownership-not-ready',
  'retain-divergent',
  'retain-unsafe',
  'retain-invalid',
  'would-remove',
  'removed',
  'no-manifest',
  'not-required',
]);

const retryable = (reason) => ({ status: 'retryable', reason });
const notReady = (reason) => ({ status: 'ownership-not-ready', reason });

function isTransientMarker(result) {
  return result.status === 'unreadable'
    || (result.status === 'unsafe'
      && (result.reason === 'changed-during-read' || result.reason === 'project-directory-missing'));
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Why a legacy file is not a proven duplicate of the current SQLite state,
 * or null when it is. Never returns content.
 * @returns {null|'malformed'|'unsupported'|'project-mismatch'|'divergent'}
 */
function judge(entry, project, categories) {
  if (entry.oversized) return 'malformed';
  let text;
  try { text = utf8.decode(entry.bytes); } catch { return 'malformed'; }
  const parsed = parseLegacyManifestContent(text);
  if (parsed.status !== 'valid') return parsed.status;
  if (parsed.manifest.id !== project.id) return 'project-mismatch';
  return describeLegacyManifestDivergence(parsed.manifest, project, categories) ? 'divergent' : null;
}

function retainedClass(reasons) {
  if (reasons.some((reason) => reason.endsWith('-divergent'))) return 'retain-divergent';
  if (reasons.some((reason) => reason.endsWith('-unsafe'))) return 'retain-unsafe';
  return 'retain-invalid';
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/legacy-manifest-cleanup-repository.js').createLegacyManifestCleanupRepository>} deps.repository
 * @param {ReturnType<import('../data/project-directory-ownership-repository.js').createProjectDirectoryOwnershipRepository>} deps.ownershipRepository
 * @param {ReturnType<import('../data/project-ownership-adoption-repository.js').createProjectOwnershipAdoptionRepository>} deps.adoptionRepository
 * @param {ReturnType<import('./project-operation-coordinator.js').createProjectOperationCoordinator>} deps.projectOperationCoordinator
 * @param {string} deps.projectsRoot
 */
export function createLegacyManifestCleanupService({
  repository, ownershipRepository, adoptionRepository, projectOperationCoordinator, projectsRoot,
  maintenanceState = null, managedUploadTracker = null, applicationLogger = null,
  batchSize = 32,
  deferDelayMs = 5_000,
  retryBaseDelayMs = 60_000,
  retryMaxDelayMs = 30 * 60_000,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  if (!repository || !ownershipRepository || !adoptionRepository || !projectOperationCoordinator || !projectsRoot) {
    throw new Error('Legacy manifest cleanup requires repository, ownership, adoption, coordinator, and projects root dependencies.');
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

  // ─── Ownership gate ─────────────────────────────────────────────────

  /**
   * Bound SQLite ownership + matching marker at the safely resolved stored
   * directory, with no adoption/recovery process still holding the project.
   * @returns {{ absPath: string, token: string } | { status: string, reason: string }}
   */
  function checkOwnership(project) {
    const row = ownershipRepository.findByProjectId(project.id);
    if (!row) return notReady('unbound');
    if (row.state !== 'bound') return notReady('pending');
    const adoption = adoptionRepository.getClassification(project.id);
    if (adoption) {
      return notReady(adoption.status === 'recovery-required' ? 'ownership-recovery-required' : 'ownership-retryable');
    }
    const dir = inspectStoredProjectDirectory(projectsRoot, project);
    if (!dir.absPath) {
      return dir.classification.status === 'retryable'
        ? retryable(dir.classification.reason) : notReady(dir.classification.reason);
    }
    const marker = readProjectOwnershipMarker(dir.absPath);
    if (isTransientMarker(marker)) return retryable('marker-unavailable');
    if (marker.status !== 'valid') return notReady(`marker-${marker.status}`);
    if (marker.token !== row.token) return notReady('marker-mismatch');
    return { absPath: dir.absPath, token: row.token };
  }

  // ─── One candidate ──────────────────────────────────────────────────

  /**
   * @returns {{ result: 'absent'|'would-remove'|'removed'|'retained'|'retryable'|'ownership-not-ready',
   *   kind: string, reason?: string }}
   */
  function evaluateEntry(project, categories, owner, { name, kind }, dryRun) {
    const entry = inspectLegacyManifestEntry(path.join(owner.absPath, name));
    if (entry.status === 'missing') return { result: 'absent', kind };
    if (entry.status === 'unreadable') return { result: 'retryable', kind, reason: `${kind}-unavailable` };
    if (entry.status === 'unsafe') {
      return entry.reason === 'changed-during-read'
        ? { result: 'retryable', kind, reason: `${kind}-changed` }
        : { result: 'retained', kind, reason: `${kind}-unsafe` };
    }
    const verdict = judge(entry, project, categories);
    // Not a proven duplicate: kept exactly as it is. An interrupted
    // removal's quarantine is kept too, never guessed back into place.
    if (verdict) return { result: 'retained', kind, reason: `${kind}-${verdict}` };
    if (dryRun) return { result: 'would-remove', kind };

    // Immediately before removal: ownership still bound, marker still ours.
    const again = checkOwnership(project);
    if (!again.absPath) return { result: again.status, kind, reason: again.reason };
    if (again.absPath !== owner.absPath || again.token !== owner.token) {
      return { result: 'retryable', kind, reason: 'state-changed' };
    }
    const removal = removeProvenLegacyManifestEntry(owner.absPath, name, entry.evidence);
    switch (removal.status) {
      case 'removed': return { result: 'removed', kind };
      case 'gone': return { result: 'retryable', kind, reason: `${kind}-changed` };
      case 'changed':
        return { result: 'retryable', kind, reason: removal.retained ? 'quarantine-retained' : `${kind}-changed` };
      case 'quarantined': return { result: 'retryable', kind, reason: 'removal-incomplete' };
      default:
        return { result: 'retryable', kind, reason: removal.retained ? 'quarantine-retained' : `${kind}-unavailable` };
    }
  }

  // ─── One project ────────────────────────────────────────────────────

  function inspectProject(project, dryRun) {
    if (project.project_dir == null) return { cls: 'not-required', entries: [] };
    const owner = checkOwnership(project);
    if (!owner.absPath) return { problem: owner, entries: [] };
    let names;
    try {
      names = fs.readdirSync(owner.absPath);
    } catch (err) {
      return {
        problem: retryable(err.code === 'ENOENT' || err.code === 'ENOTDIR'
          ? 'project-directory-missing' : 'project-directory-unavailable'),
        entries: [],
      };
    }
    const candidates = names
      .map((name) => ({ name, kind: legacyManifestCandidateKind(name) }))
      .filter((candidate) => candidate.kind)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.name < b.name ? -1 : 1));
    const categories = repository.listCategories(project.id);
    const entries = candidates.slice(0, MAX_CANDIDATES)
      .map((candidate) => evaluateEntry(project, categories, owner, candidate, dryRun));
    for (const candidate of candidates.slice(MAX_CANDIDATES)) {
      entries.push({ result: 'retained', kind: candidate.kind, reason: 'candidate-limit' });
    }
    return { entries };
  }

  /** Summarize one inspection into its class, count deltas, and entry row. */
  function summarize(inspection) {
    const { entries } = inspection;
    const reasonsFor = (result) => entries.filter((e) => e.result === result).map((e) => e.reason);
    const delta = {
      removed: entries.filter((e) => e.result === 'removed' && e.kind === 'manifest').length,
      tempRemoved: entries.filter((e) => e.result === 'removed' && e.kind !== 'manifest').length,
    };
    if (inspection.cls === 'not-required') return { cls: 'not-required', delta, entry: null };
    if (inspection.problem) {
      const cls = inspection.problem.status === 'retryable' ? 'retry' : 'ownership-not-ready';
      return { cls, delta, entry: { status: inspection.problem.status, reasons: [inspection.problem.reason] } };
    }
    for (const [result, cls] of [['retryable', 'retry'], ['ownership-not-ready', 'ownership-not-ready']]) {
      const reasons = reasonsFor(result);
      if (reasons.length) return { cls, delta, entry: { status: result, reasons } };
    }
    const retained = reasonsFor('retained');
    if (retained.length) return { cls: retainedClass(retained), delta, entry: { status: 'retained', reasons: retained } };
    if (entries.some((e) => e.result === 'would-remove')) return { cls: 'would-remove', delta, entry: null };
    if (delta.removed || delta.tempRemoved) return { cls: 'removed', delta, entry: null };
    return { cls: 'no-manifest', delta, entry: null };
  }

  /**
   * Decide one project, synchronously under its operation lock. Never throws.
   *
   * Only the ID comes from the caller (a page row may be stale by now): the
   * project row is reloaded from SQLite inside the lock, and that row plus
   * the categories read in `inspectProject` are the only state the ownership
   * check, comparison, and removal use. Nothing between the reload and the
   * removal decision yields. A project deleted meanwhile is reported `gone`
   * and nothing is touched.
   *
   * @returns {{ cls: string, delta: object, entry: object|null, entries: Array, gone?: true }}
   */
  function evaluate(projectId, { dryRun = false } = {}) {
    let inspection;
    try {
      inspection = projectOperationCoordinator.run(projectId, () => {
        const project = repository.findProject(projectId);
        return project ? inspectProject(project, dryRun) : { gone: true, entries: [] };
      });
    } catch (error) {
      if (error instanceof ProjectOperationError && error.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        inspection = { problem: retryable('project-busy'), entries: [] };
      } else {
        log('error', 'projects.legacy_manifest.cleanup_failed', 'Legacy manifest cleanup step failed.',
          { error, projectId });
        inspection = { problem: retryable('inspection-failed'), entries: [] };
      }
    }
    if (inspection.gone) return { gone: true, cls: null, delta: {}, entry: null, entries: [] };
    const summary = summarize(inspection);
    return { ...summary, entries: inspection.entries.map(({ result, kind, reason }) => ({ result, kind, reason: reason ?? null })) };
  }

  function sameEntry(a, b) {
    if (!a || !b) return a === b;
    return a.status === b.status && a.reasons.join(',') === b.reasons.join(',');
  }

  function logDecision(projectId, result, previous) {
    if (result.delta.removed || result.delta.tempRemoved) {
      log('info', 'projects.legacy_manifest.removed', 'Redundant legacy project manifest removed.',
        { projectId, context: { ...result.delta } });
    }
    if (!result.entry || sameEntry(result.entry, previous)) return;
    const level = result.entry.status === 'retained' ? 'info' : 'warn';
    const message = result.entry.status === 'retained'
      ? 'Legacy project manifest retained: it is not a proven duplicate of the current project.'
      : 'Legacy project manifest cleanup deferred for this project.';
    log(level, 'projects.legacy_manifest.unresolved', message,
      { projectId, context: { status: result.entry.status, reasons: result.entry.reasons } });
  }

  // ─── Runs ───────────────────────────────────────────────────────────

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
        log('info', 'projects.legacy_manifest.cleanup_pass_completed',
          'Legacy project manifest cleanup pass completed.', { context: summaryContext() });
        break;
      }
      for (const project of page) {
        const ok = withStep(() => {
          const previous = repository.getEntry(project.id);
          // The page only discovers the ID and advances the cursor.
          const result = evaluate(project.id);
          const delta = { ...result.delta };
          if (result.cls === 'no-manifest') delta.noManifest = 1;
          if (result.cls === 'not-required') delta.notRequired = 1;
          record = repository.commitStep(project.id, delta, result.entry) ?? repository.get();
          logDecision(project.id, result, previous);
        });
        if (!ok) return false;
        await yieldToEventLoop();
      }
    }
    return true;
  }

  function revisitCandidates() {
    return repository.listEntries()
      .filter((entry) => entry.status === 'retryable' || entry.status === 'ownership-not-ready')
      .map((entry) => entry.projectId);
  }

  async function runRevisits() {
    for (const projectId of revisitCandidates()) {
      const ok = withStep(() => {
        const previous = repository.getEntry(projectId);
        const result = evaluate(projectId);
        repository.commitRetry(projectId, result.delta, result.entry);
        logDecision(projectId, result, previous);
      });
      if (!ok) return false;
      await yieldToEventLoop();
    }
    return true;
  }

  async function run() {
    // Ownership adoption decides binding first; until its one-time pass is
    // done, most legacy projects would only report "not ready".
    if (!adoptionRepository.isInitialPassComplete()) return 'deferred';
    const record = repository.get();
    return record?.phase === 'running' ? runInitialPass() : runRevisits();
  }

  function scheduleTimer(delay) {
    if (halted() || timer) return;
    timer = schedule(() => { timer = null; signal(); }, delay);
    timer?.unref?.();
  }

  function scheduleRevisit() {
    if (!revisitCandidates().length) { backoffAttempt = 0; return; }
    const delay = Math.min(retryBaseDelayMs * 2 ** backoffAttempt, retryMaxDelayMs);
    backoffAttempt = Math.min(backoffAttempt + 1, 30);
    scheduleTimer(delay);
  }

  /** Run pending cleanup work in the background (coalesced). */
  function signal() {
    if (halted()) return;
    if (runner) { wakeRequested = true; return; }
    if (timer) { cancel(timer); timer = null; }
    let failed = false;
    let finished = false;
    runner = Promise.resolve().then(run).then((result) => { finished = result; failureRetries = 0; }, (error) => {
      failed = true;
      log('error', 'projects.legacy_manifest.cleanup_lifecycle_failed', 'Legacy manifest cleanup paused.', { error });
    }).finally(() => {
      runner = null;
      if (halted()) return;
      if (wakeRequested) { wakeRequested = false; signal(); return; }
      if (failed) {
        if (++failureRetries <= MAX_RUNNER_RETRIES) scheduleTimer(250 * 2 ** (failureRetries - 1));
        return;
      }
      if (finished === 'deferred') { scheduleTimer(deferDelayMs); return; }
      if (!finished) { scheduleTimer(250); return; }
      try { scheduleRevisit(); } catch { /* the next startup or signal retries */ }
    });
  }

  /** Synchronous startup/adoption step: create or load the lifecycle record. */
  function prepare() {
    repository.initialize();
    repository.pruneDeleted();
    return readiness();
  }

  function summaryContext() {
    const status = readiness();
    return { counts: status.counts, current: status.current };
  }

  /**
   * Aggregate progress, without paths or manifest content: cumulative
   * removals, pass counts, and how many projects currently have retained,
   * retryable, or not-yet-ready legacy files.
   */
  function readiness() {
    let record = null;
    try { record = repository.get(); } catch { /* reported as not complete */ }
    const entries = repository.listEntries();
    const current = {
      retryable: 0, ownershipNotReady: 0, retainedDivergent: 0, retainedInvalid: 0, retainedUnsafe: 0,
    };
    for (const entry of entries) {
      if (entry.status === 'retryable') current.retryable++;
      else if (entry.status === 'ownership-not-ready') current.ownershipNotReady++;
      else {
        const cls = retainedClass(entry.reasons);
        if (cls === 'retain-divergent') current.retainedDivergent++;
        else if (cls === 'retain-unsafe') current.retainedUnsafe++;
        else current.retainedInvalid++;
      }
    }
    return {
      passComplete: record?.phase === 'completed',
      pass: record ? { phase: record.phase, cursor: record.cursor, upperBound: record.upperBound } : null,
      counts: record ? { ...record.counts } : null,
      current,
    };
  }

  /**
   * Read-only classification with exactly the deletion predicate, but
   * nothing is removed and no lifecycle state is written. Returns per-project
   * classes (see LEGACY_MANIFEST_CLEANUP_CLASSES) and per-file results, with
   * no paths or manifest content.
   *
   * @param {{ projectIds?: number[] }} [options] - default: every project
   */
  async function dryRun({ projectIds = null } = {}) {
    const projects = [];
    const collect = (projectId) => {
      const result = evaluate(projectId, { dryRun: true });
      if (result.gone) return;
      projects.push({ projectId, classification: result.cls, reasons: result.entry?.reasons ?? [], entries: result.entries });
    };
    if (projectIds) {
      for (const projectId of projectIds) {
        collect(projectId);
        await yieldToEventLoop();
      }
    } else {
      let cursor = 0;
      for (;;) {
        const page = repository.page(cursor, Number.MAX_SAFE_INTEGER, batchSize);
        if (!page.length) break;
        for (const project of page) {
          collect(project.id);
          cursor = project.id;
          await yieldToEventLoop();
        }
      }
    }
    const summary = Object.fromEntries(LEGACY_MANIFEST_CLEANUP_CLASSES.map((cls) => [cls, 0]));
    for (const project of projects) summary[project.classification]++;
    return { projects, summary };
  }

  return {
    prepare,
    signal,
    readiness,
    dryRun,
    /** One project's current cleanup entry (no paths), or null. */
    getProjectStatus: (projectId) => repository.getEntry(projectId),
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
