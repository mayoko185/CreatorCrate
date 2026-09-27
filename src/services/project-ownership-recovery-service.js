/**
 * Explicit project-directory ownership recovery (PM-1C2A).
 *
 * One operator-authorized operation: "the directory currently stored for
 * project A is the directory that should belong to project A." On success the
 * project's `project_directory_ownership` row is `bound` to token X and the
 * stored directory's `.creatorcrate-owner` marker carries X, so PM-1B-gated
 * operations work immediately (they read both live on every operation).
 *
 * Authority. The operator's confirmation replaces the legacy proof PM-1C1
 * requires; nothing is imported from `project.json`, which is never read.
 * Recovery is never invoked automatically (scan, rename, delete, edit,
 * processing, reconciliation, startup, retry timers) — only from an explicit
 * request carrying the `statusVersion` the operator was shown.
 *
 * Scope. Only the directory already stored in `projects.project_dir` is ever
 * considered, resolved under the same safe-path rules as PM-1B/PM-1C1. A
 * structurally invalid or unsafe stored path is refused, never "fixed", and
 * `project_dir` is never changed.
 *
 * Token choice: the existing bound token, else the existing pending token,
 * else an existing valid marker token no row holds, else a fresh token. A
 * marker token held by another project is never taken: that is refused and
 * the marker left untouched.
 *
 * Plans (row × marker, after the safe-directory check):
 *   create-marker     none    + missing       → pending X, create X, bind
 *   adopt-marker      none    + valid X free  → pending X, re-verify, bind
 *   complete-pending  pending X + X           → re-verify, bind
 *   publish-pending   pending X + missing     → create X, bind
 *   restore-marker    bound X + missing       → create X (row already bound)
 *   replace-marker    any row + malformed, or pending/bound X + free Y
 *                     → (pending if no row) → quarantine → create → bind
 * A symlink or non-regular marker is refused (`marker-unsafe`).
 *
 * Every SQLite write is a single conditional statement on exact (project,
 * token, state); no transaction spans filesystem I/O. The whole attempt is
 * synchronous under the project's operation lock, so no in-process scan or
 * mutation interleaves. Unavailability (share down, EIO, permissions) fails
 * the attempt and keeps the previous recoverable state; it never becomes a
 * permanent conflict. Filesystem identity is used only within one attempt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  createProjectOwnershipMarker,
  discardQuarantinedProjectOwnershipMarker,
  generateProjectOwnershipToken,
  inspectProjectOwnershipMarker,
  quarantineProjectOwnershipMarker,
  restoreQuarantinedProjectOwnershipMarker,
} from '../storage/project-ownership-marker.js';
import { ProjectOwnershipTokenConflictError } from '../data/project-directory-ownership-repository.js';
import { inspectStoredProjectDirectory } from './project-ownership-adoption-service.js';
import { ProjectOperationError } from './project-operation-coordinator.js';

export const PROJECT_OWNERSHIP_RECOVERY_ERROR_CODES = Object.freeze([
  'RECOVERY_CONFIRMATION_REQUIRED', // 400: no/invalid statusVersion
  'PROJECT_NOT_FOUND', // 404
  'RECOVERY_STATE_CHANGED', // 409: statusVersion is stale, or state changed mid-attempt
  'RECOVERY_NOT_REQUIRED', // 409: nothing to recover
  'RECOVERY_BLOCKED', // 409: needs manual/filesystem resolution; `reason` says why
  'RECOVERY_UNAVAILABLE', // 503: retry later; `reason` says why
]);

const HTTP_STATUS = {
  RECOVERY_CONFIRMATION_REQUIRED: 400,
  PROJECT_NOT_FOUND: 404,
  RECOVERY_STATE_CHANGED: 409,
  RECOVERY_NOT_REQUIRED: 409,
  RECOVERY_BLOCKED: 409,
  RECOVERY_UNAVAILABLE: 503,
};

const MESSAGES = {
  RECOVERY_CONFIRMATION_REQUIRED: 'Ownership recovery must be confirmed against the current recovery status.',
  PROJECT_NOT_FOUND: 'Project not found.',
  RECOVERY_STATE_CHANGED: 'Project ownership state changed since it was reviewed. Review the current status and confirm again.',
  RECOVERY_NOT_REQUIRED: 'Project directory ownership does not need recovery.',
  RECOVERY_BLOCKED: 'Project directory ownership cannot be recovered automatically from this state.',
  RECOVERY_UNAVAILABLE: 'Project directory ownership cannot be recovered right now. Try again later.',
};

/**
 * Messages never contain paths or tokens. `status` is the HTTP status;
 * `recovery` (when present) is the fresh public status.
 */
export class ProjectOwnershipRecoveryError extends Error {
  constructor(code, { reason = null, recovery = null } = {}) {
    super(MESSAGES[code]);
    this.name = 'ProjectOwnershipRecoveryError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.reason = reason;
    this.recovery = recovery;
  }
}

const STATUS_VERSION_RE = /^[0-9a-f]{32}$/;

const retryLater = (reason) => ({ action: 'retry-later', reason });
const blocked = (reason) => ({ action: 'blocked', reason });

// Marker observations as the browser may see them: never a token or path.
function publicMarker(marker, owner, row) {
  if (!marker) return null;
  switch (marker.status) {
    case 'missing': return 'missing';
    case 'malformed': return 'malformed';
    case 'unsafe': return marker.reason === 'changed-during-read' || marker.reason === 'project-directory-missing'
      ? 'unavailable' : 'unsafe';
    case 'unreadable': return 'unavailable';
    case 'valid':
      if (row && marker.token === row.token) return 'matching';
      if (owner) return 'owned-by-another-project';
      return row ? 'different' : 'unclaimed';
    default: return 'unavailable';
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/project-directory-ownership-repository.js').createProjectDirectoryOwnershipRepository>} deps.ownershipRepository
 * @param {ReturnType<import('../data/project-ownership-adoption-repository.js').createProjectOwnershipAdoptionRepository>} deps.adoptionRepository
 * @param {string} deps.projectsRoot
 * @param {ReturnType<import('./project-operation-coordinator.js').createProjectOperationCoordinator>} deps.projectOperationCoordinator
 */
export function createProjectOwnershipRecoveryService({
  ownershipRepository, adoptionRepository, projectsRoot, projectOperationCoordinator,
  maintenanceState = null, applicationLogger = null,
} = {}) {
  if (!ownershipRepository || !adoptionRepository || !projectsRoot || !projectOperationCoordinator) {
    throw new Error('Project ownership recovery requires ownership, adoption, projects root, and coordinator dependencies.');
  }

  const log = (level, event, message, extra = {}) => {
    try {
      applicationLogger?.[level]?.({ kind: 'diagnostic', subsystem: 'projects', event, message, ...extra });
    } catch { /* diagnostics never change recovery behavior */ }
  };

  const fail = (code, extra) => new ProjectOwnershipRecoveryError(code, extra);

  const logRetained = (projectId, context) => log('warn', 'projects.ownership.recovery_quarantine_retained',
    'The previous ownership marker was left in quarantine inside the project directory.', { projectId, context });

  // ─── Observation ─────────────────────────────────────────────────────

  function awaitingAdoption(projectId) {
    let record = null;
    try { record = adoptionRepository.get(); } catch { return true; }
    return !record || (record.phase === 'running' && projectId > record.cursor && projectId <= record.upperBound);
  }

  // Current directory identity, only for continuity within this attempt.
  function directoryIdentity(absPath) {
    try {
      const stats = fs.lstatSync(absPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return { changed: true };
      return { identity: { dev: stats.dev, ino: stats.ino } };
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { changed: true };
      return { unavailable: true };
    }
  }

  /**
   * Classify the project's live state. Pure inspection: writes nothing.
   * Returns an internal observation (may hold the token; never exposed).
   */
  function observe(project) {
    const row = ownershipRepository.findByProjectId(project.id);
    const entry = adoptionRepository.readClassification(project.id);
    const classification = entry?.classification ?? null;
    const base = {
      project, row, classification, classificationRevision: entry?.revision ?? null,
      marker: null, owner: null, absPath: null, identity: null, plan: null,
    };
    const decide = (decision) => ({ ...base, ...decision });

    if (maintenanceState?.active) return decide(retryLater('maintenance'));
    if (project.project_dir == null) {
      return decide(row ? blocked('binding-without-directory') : { action: 'none', reason: 'not-required' });
    }
    const dir = inspectStoredProjectDirectory(projectsRoot, project);
    if (!dir.absPath) {
      const { status, reason } = dir.classification;
      return decide(status === 'retryable' ? retryLater(reason) : blocked(reason));
    }
    base.absPath = dir.absPath;
    const current = directoryIdentity(dir.absPath);
    if (current.unavailable) return decide(retryLater('project-directory-unavailable'));
    if (current.changed) return decide(retryLater('project-directory-missing'));
    base.identity = current.identity;

    const marker = inspectProjectOwnershipMarker(dir.absPath);
    base.marker = marker;
    if (marker.status === 'unreadable') return decide(retryLater('marker-unavailable'));
    if (marker.status === 'unsafe') {
      if (marker.reason === 'changed-during-read') return decide(retryLater('marker-unavailable'));
      if (marker.reason === 'project-directory-missing') return decide(retryLater('project-directory-missing'));
      if (marker.reason === 'project-directory-not-directory') return decide(blocked('project-directory-unsafe'));
      return decide(blocked('marker-unsafe'));
    }
    if (marker.status === 'valid') {
      const owner = ownershipRepository.findByToken(marker.token);
      if (owner && owner.projectId !== project.id) {
        base.owner = owner;
        return decide(blocked('marker-token-in-use'));
      }
    }

    let plan;
    if (row?.state === 'bound') {
      if (marker.status === 'valid' && marker.token === row.token) return decide({ action: 'none', reason: 'bound' });
      plan = marker.status === 'missing' ? 'restore-marker' : 'replace-marker';
    } else if (row?.state === 'pending') {
      if (marker.status === 'valid' && marker.token === row.token) plan = 'complete-pending';
      else plan = marker.status === 'missing' ? 'publish-pending' : 'replace-marker';
    } else if (marker.status === 'missing') {
      plan = 'create-marker';
    } else {
      plan = marker.status === 'valid' ? 'adopt-marker' : 'replace-marker';
    }
    base.plan = plan;

    // Work the automatic lifecycle still owns is not offered for explicit
    // recovery: a transiently unavailable project, one the one-time pass has
    // not reached, or an unclassified pending publication it will finish.
    if (classification?.status === 'retryable') return decide(retryLater(classification.reason));
    // (The pass never repairs a bound row, so a bound project never waits.)
    if (!classification && row?.state !== 'bound' && (row?.state === 'pending' || awaitingAdoption(project.id))) {
      return decide(retryLater('automatic-adoption-pending'));
    }
    return decide({ action: 'recover', reason: classification?.reason ?? plan });
  }

  // Opaque fingerprint of exactly the facts a confirmation authorizes. The
  // token only enters a one-way hash; identity (dev/ino) is excluded so a
  // share reconnect does not invalidate an otherwise unchanged state.
  function versionOf(obs) {
    const facts = [
      obs.project.id, obs.project.project_dir ?? null,
      obs.row?.state ?? null, obs.row?.token ?? null,
      obs.marker?.status ?? null, obs.marker?.reason ?? null, obs.marker?.token ?? null,
      obs.marker?.evidence?.fingerprint ?? null,
      obs.action, obs.reason, obs.plan,
    ];
    return crypto.createHash('sha256').update(`creatorcrate.ownership-recovery.v1\0${JSON.stringify(facts)}`)
      .digest('hex').slice(0, 32);
  }

  function present(obs) {
    return {
      projectId: obs.project.id,
      action: obs.action,
      reason: obs.reason,
      plan: obs.action === 'recover' ? obs.plan : null,
      binding: obs.row?.state ?? null,
      marker: publicMarker(obs.marker, obs.owner, obs.row),
      classification: obs.classification
        ? { status: obs.classification.status, reason: obs.classification.reason }
        : null,
      statusVersion: versionOf(obs),
    };
  }

  function findProject(projectId) {
    if (!Number.isSafeInteger(projectId) || projectId < 1) return null;
    return adoptionRepository.findProject(projectId);
  }

  /**
   * Retire an attention classification this observation proved obsolete.
   * Only the healthy `none`/`bound` result qualifies — a bound row whose
   * marker was just read and matches — never an unavailable, uncertain,
   * blocked or recoverable one. Skipped while another operation holds the
   * project. The delete is conditional on the exact stored value observed
   * and on the same bound token, so a classification written since (or a
   * binding changed since) survives. Advisory bookkeeping: a failure keeps
   * the classification and the status is still reported.
   */
  function retireObsoleteClassification(obs) {
    if (obs.action !== 'none' || obs.reason !== 'bound' || !obs.classification) return obs;
    if (obs.row?.state !== 'bound' || obs.marker?.status !== 'valid' || obs.marker.token !== obs.row.token) return obs;
    if (projectOperationCoordinator.isActive?.(obs.project.id)) return obs;
    let retired = false;
    try {
      retired = adoptionRepository.retireClassification(obs.project.id,
        { revision: obs.classificationRevision, token: obs.row.token });
    } catch (error) {
      log('warn', 'projects.ownership.recovery_classification_stale',
        'Ownership is healthy but its stale adoption classification could not be cleared.', { projectId: obs.project.id, error });
    }
    if (!retired) return obs;
    log('info', 'projects.ownership.classification_retired',
      'A stale ownership classification was retired after ownership was verified healthy.',
      { projectId: obs.project.id, context: { status: obs.classification.status, reason: obs.classification.reason } });
    return { ...obs, classification: null, classificationRevision: null };
  }

  /**
   * Public recovery status: safe to show (no path, no token).
   *
   * Not strictly read-only: when this inspection positively establishes the
   * healthy state (bound row + matching marker), a durable attention
   * classification it contradicts is retired (see
   * `retireObsoleteClassification`), so later Project Detail renders — which
   * read SQLite only — stop showing a stale notice. No other state is
   * written, and no filesystem state is ever changed here.
   * @returns {object|null} null for an unknown project
   */
  function getRecoveryStatus(projectId) {
    const project = findProject(projectId);
    return project ? present(retireObsoleteClassification(observe(project))) : null;
  }

  /**
   * Cheap project-page hint (PM-1C2B): whether durable SQLite state alone
   * says the project needs the operator's attention. Never touches the
   * filesystem, so rendering a project costs no marker read; the detailed
   * status above is fetched only when the operator opens the recovery UI.
   * A bound project whose marker later disappeared is not visible here: the
   * gated operation itself reports that.
   * @returns {'attention'|'unavailable'|null}
   */
  function getAttentionHint(projectId) {
    const project = findProject(projectId);
    if (!project || project.project_dir == null) return null;
    const classification = adoptionRepository.getClassification(project.id);
    if (classification?.status === 'recovery-required') return 'attention';
    if (classification?.status === 'retryable') return 'unavailable';
    const row = ownershipRepository.findByProjectId(project.id);
    if (row?.state === 'bound') return null;
    if (row?.state === 'pending' || awaitingAdoption(project.id)) return 'unavailable';
    return 'attention';
  }

  // ─── Execution ───────────────────────────────────────────────────────

  function recordBlocked(projectId, reason) {
    try {
      adoptionRepository.setClassification(projectId, { status: 'recovery-required', reason });
    } catch { /* classification is advisory; the refusal stands */ }
  }

  function execute(obs) {
    const { project, absPath, identity, marker } = obs;
    const projectId = project.id;
    let createdRow = null;
    let quarantine = null;

    // Continuity of the stored directory within this attempt.
    const checkDirectory = () => {
      const now = directoryIdentity(absPath);
      if (now.unavailable) throw fail('RECOVERY_UNAVAILABLE', { reason: 'project-directory-unavailable' });
      if (now.changed || now.identity.dev !== identity.dev || now.identity.ino !== identity.ino) {
        throw fail('RECOVERY_STATE_CHANGED', { reason: 'project-directory-changed' });
      }
    };

    // Undo only what this attempt did before its marker was published:
    // the pending row it created (exact identity) and the quarantine.
    const rollBack = () => {
      if (createdRow) {
        try { ownershipRepository.deletePending(projectId, createdRow); } catch (error) {
          log('error', 'projects.ownership.recovery_rollback_failed', 'Ownership recovery could not remove its pending binding.',
            { projectId, error });
        }
      }
      if (quarantine) {
        const restore = restoreQuarantinedProjectOwnershipMarker(absPath, quarantine);
        if (restore !== 'restored' && restore !== 'gone') logRetained(projectId, { restore });
      }
    };

    const createPending = (token, { conflictReason }) => {
      let row;
      try {
        row = ownershipRepository.createPending(projectId, token);
      } catch (err) {
        if (err instanceof ProjectOwnershipTokenConflictError) {
          if (conflictReason) recordBlocked(projectId, conflictReason);
          throw conflictReason
            ? fail('RECOVERY_BLOCKED', { reason: conflictReason })
            : fail('RECOVERY_STATE_CHANGED', { reason: 'token-conflict' });
        }
        throw err;
      }
      if (!row) throw fail('RECOVERY_STATE_CHANGED', { reason: 'binding-changed' });
      createdRow = token;
    };

    // Re-inspect the marker and require exactly what was classified.
    const reconfirmMarker = () => {
      const now = inspectProjectOwnershipMarker(absPath);
      if (now.status === 'unreadable' || (now.status === 'unsafe' && now.reason === 'changed-during-read')) {
        throw fail('RECOVERY_UNAVAILABLE', { reason: 'marker-unavailable' });
      }
      if (now.status !== marker.status || now.token !== marker.token
        || now.evidence?.fingerprint !== marker.evidence?.fingerprint) {
        throw fail('RECOVERY_STATE_CHANGED', { reason: 'marker-changed' });
      }
      return now;
    };

    // Bind exactly (project, token, pending). A throw leaves pending X with
    // marker X — a completable state — so nothing published is undone.
    const bind = (token) => {
      let bound;
      try {
        bound = ownershipRepository.markBound(projectId, token);
      } catch (error) {
        createdRow = null;
        quarantine = null;
        log('error', 'projects.ownership.recovery_bind_failed', 'Ownership recovery could not finalize its binding.',
          { projectId, error });
        throw fail('RECOVERY_UNAVAILABLE', { reason: 'binding-failed' });
      }
      if (!bound) throw fail('RECOVERY_STATE_CHANGED', { reason: 'binding-changed' });
    };

    // Exclusively publish marker `token` (never over an existing entry).
    const publish = (token) => {
      checkDirectory();
      let result;
      try {
        result = createProjectOwnershipMarker(absPath, token);
      } catch (err) {
        if (err.code === 'RECOVERY_REQUIRED') {
          // The new marker was exposed but never confirmed (it may already
          // be foreign), so it stays, and the old marker stays quarantined.
          if (quarantine) logRetained(projectId);
          quarantine = null;
          recordBlocked(projectId, 'marker-write-remnant');
          throw fail('RECOVERY_UNAVAILABLE', { reason: 'marker-write-remnant' });
        }
        if (err.code === 'PROJECT_DIRECTORY_UNSAFE') throw fail('RECOVERY_STATE_CHANGED', { reason: 'project-directory-changed' });
        throw fail('RECOVERY_UNAVAILABLE', { reason: 'marker-write-failed' });
      }
      // Something appeared at the marker path: never overwrite it.
      if (result.status === 'exists') throw fail('RECOVERY_STATE_CHANGED', { reason: 'marker-changed' });
      // Published: from here on the attempt rolls forward, never back. The
      // pending row and the new marker agree, so a failure below leaves a
      // completable state, and the old marker stays quarantined as evidence.
      createdRow = null;
      const retained = quarantine;
      quarantine = null;
      try {
        checkDirectory();
        const now = inspectProjectOwnershipMarker(absPath);
        if (now.status !== 'valid' || now.token !== token) {
          throw now.status === 'unreadable'
            ? fail('RECOVERY_UNAVAILABLE', { reason: 'marker-unavailable' })
            : fail('RECOVERY_STATE_CHANGED', { reason: 'marker-changed' });
        }
      } catch (err) {
        if (retained) logRetained(projectId);
        throw err;
      }
      return retained;
    };

    try {
      let token;
      let retained = null;
      switch (obs.plan) {
        case 'create-marker':
          token = generateProjectOwnershipToken();
          createPending(token, { conflictReason: null });
          publish(token);
          bind(token);
          break;
        case 'adopt-marker':
          token = marker.token;
          createPending(token, { conflictReason: 'marker-token-in-use' });
          checkDirectory();
          reconfirmMarker();
          createdRow = null; // the marker already carries it: pending X + X is completable
          bind(token);
          break;
        case 'complete-pending':
          token = obs.row.token;
          checkDirectory();
          reconfirmMarker();
          bind(token);
          break;
        case 'publish-pending':
          token = obs.row.token;
          publish(token);
          bind(token);
          break;
        case 'restore-marker':
          token = obs.row.token;
          publish(token);
          break;
        case 'replace-marker': {
          token = obs.row?.token ?? generateProjectOwnershipToken();
          if (!obs.row) createPending(token, { conflictReason: null });
          checkDirectory();
          const confirmed = reconfirmMarker();
          if (confirmed.status === 'valid' && ownershipRepository.findByToken(confirmed.token)) {
            throw fail('RECOVERY_STATE_CHANGED', { reason: 'marker-changed' });
          }
          let moved;
          try {
            moved = quarantineProjectOwnershipMarker(absPath, confirmed.evidence);
          } catch (err) {
            if (err.retained) logRetained(projectId);
            throw fail('RECOVERY_UNAVAILABLE', { reason: 'marker-quarantine-failed' });
          }
          if (moved.status !== 'quarantined') {
            if (moved.retained) logRetained(projectId);
            throw fail('RECOVERY_STATE_CHANGED', { reason: 'marker-changed' });
          }
          quarantine = moved.quarantine;
          retained = publish(token);
          if (obs.row?.state !== 'bound') {
            try { bind(token); } catch (err) {
              logRetained(projectId);
              throw err;
            }
          }
          break;
        }
        default:
          throw new Error(`Unknown ownership recovery plan "${obs.plan}".`);
      }

      // Committed: SQLite bound(token) and marker(token) agree.
      try { adoptionRepository.setClassification(projectId, null); } catch (error) {
        log('warn', 'projects.ownership.recovery_classification_stale',
          'Ownership was recovered but its adoption classification could not be cleared.', { projectId, error });
      }
      let cleanup = 'none';
      if (retained) {
        cleanup = discardQuarantinedProjectOwnershipMarker(retained) ? 'removed' : 'retained';
        if (cleanup === 'retained') logRetained(projectId);
      }
      return { plan: obs.plan, cleanup };
    } catch (err) {
      rollBack();
      throw err;
    }
  }

  function recoverLocked(projectId, statusVersion) {
    const project = findProject(projectId);
    if (!project) throw fail('PROJECT_NOT_FOUND');
    const obs = observe(project);
    const shown = present(obs);
    if (shown.statusVersion !== statusVersion) throw fail('RECOVERY_STATE_CHANGED', { recovery: shown });

    if (obs.action === 'retry-later') throw fail('RECOVERY_UNAVAILABLE', { reason: obs.reason, recovery: shown });
    if (obs.action === 'blocked') {
      recordBlocked(projectId, obs.reason);
      throw fail('RECOVERY_BLOCKED', { reason: obs.reason, recovery: getRecoveryStatus(projectId) });
    }
    if (obs.action === 'none') {
      // Already bound with a matching marker: only a stale classification
      // (e.g. left by an earlier failure) remains to clear.
      if (obs.reason === 'bound' && obs.classification) {
        adoptionRepository.setClassification(projectId, null);
        return { outcome: 'already-bound', cleanup: 'none', recovery: getRecoveryStatus(projectId) };
      }
      throw fail('RECOVERY_NOT_REQUIRED', { reason: obs.reason, recovery: shown });
    }

    let result;
    try {
      result = execute(obs);
    } catch (err) {
      if (err instanceof ProjectOwnershipRecoveryError) {
        log(err.code === 'RECOVERY_UNAVAILABLE' ? 'warn' : 'error', 'projects.ownership.recovery_failed',
          'Explicit project ownership recovery did not complete.',
          { projectId, context: { code: err.code, reason: err.reason, plan: obs.plan } });
        err.recovery ??= getRecoveryStatus(projectId);
        throw err;
      }
      log('error', 'projects.ownership.recovery_failed', 'Explicit project ownership recovery failed.',
        { projectId, error: err, context: { plan: obs.plan } });
      throw fail('RECOVERY_UNAVAILABLE', { reason: 'recovery-failed', recovery: getRecoveryStatus(projectId) });
    }
    log('info', 'projects.ownership.recovered', 'Project directory ownership recovered by operator.',
      { projectId, context: { plan: result.plan, cleanup: result.cleanup } });
    return { outcome: 'recovered', plan: result.plan, cleanup: result.cleanup, recovery: getRecoveryStatus(projectId) };
  }

  /**
   * Explicitly recover one project's ownership. `statusVersion` must equal
   * the `statusVersion` of the status the operator confirmed; any change in
   * between refuses with RECOVERY_STATE_CHANGED.
   *
   * @returns {{ outcome: 'recovered'|'already-bound', plan?: string, cleanup: string, recovery: object }}
   * @throws {ProjectOwnershipRecoveryError}
   */
  function recover(projectId, { statusVersion } = {}) {
    if (typeof statusVersion !== 'string' || !STATUS_VERSION_RE.test(statusVersion)) {
      throw fail('RECOVERY_CONFIRMATION_REQUIRED');
    }
    if (!findProject(projectId)) throw fail('PROJECT_NOT_FOUND');
    try {
      return projectOperationCoordinator.run(projectId, () => recoverLocked(projectId, statusVersion));
    } catch (err) {
      if (err instanceof ProjectOperationError && err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        throw fail('RECOVERY_UNAVAILABLE', { reason: 'project-busy' });
      }
      throw err;
    }
  }

  return { getRecoveryStatus, getAttentionHint, recover };
}
