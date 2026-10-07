import fs from 'node:fs';
import path from 'node:path';
import { createProcessingRecoveryEvidenceRepository } from '../data/processing-recovery-evidence-repository.js';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { matchesOwnedIdentity, removeFileIfExactIdentityMatches } from './owned-file.js';
import { ownedPathContentSnapshot, ownedPathContinuityFailure } from './owned-path-content.js';
import { createProjectDirectoryOwnershipVerifier, isKnownDirectoryIdentity } from './project-directory-ownership.js';
import { isDurableBirthtimeNs } from './asset-processing-shared.js';

/**
 * Generic evidence listing, advisory refresh, locked cleanup of resolved private
 * artifacts, and the manual-scan acceptance settlement. Cleanup requires fresh ownership,
 * content and continuity proof; it never changes public state, lifecycle, retention,
 * identity, content proof, checkpoint or gate. Only reconcileAfterManualScan settles
 * lifecycle, checkpoints and the gate, and it touches no file. No directory inventory or
 * manifest is read.
 *
 * Authority: an evidence row and its stored observation are advisory. `cleanupPolicyEligible`
 * only says a row may undergo a fresh cleanup proof; it is never deletion authority. A file
 * may change immediately after a refresh, so any later cleanup must re-prove the exact
 * identity and content of the path itself, immediately before acting.
 */

export const EVIDENCE_ARTIFACT_CLASS = Object.freeze({
  private: 'private',
  publicTracking: 'public-tracking',
  unknown: 'unknown',
});

// Each operation's private staging root, as created by asset-processing-service.js
// (createStagingDirectory). Archive stages and backups share the Watermark workspace.
const STAGING_ROOT = Object.freeze({
  'workflow-prompt': '.creatorcrate-workflow-prompts-staging',
  watermark: '.creatorcrate-watermark-staging',
  archive: '.creatorcrate-watermark-staging',
  convert: '.creatorcrate-convert-staging',
});

// A staged file is `<root>/<token>.<name>` (stagingFile): a 16-hex workspace token and the
// role's own name, always a direct child of the staging root.
const TOKEN = '[0-9a-f]{16}';
const INDEX = '(?:0|[1-9][0-9]*)';

// `liveTarget` names the persisted row field holding the project path whose accepted
// current content a manual scan compares with this private copy (see the catalog).
function privateRole(operation, name, liveTarget) {
  return Object.freeze({
    artifactClass: EVIDENCE_ARTIFACT_CLASS.private,
    root: STAGING_ROOT[operation],
    name: new RegExp(`^${TOKEN}\\.${name}$`),
    liveTarget,
  });
}

const PUBLIC_TRACKING = Object.freeze({ artifactClass: EVIDENCE_ARTIFACT_CLASS.publicTracking });

/**
 * The accepted operation+role contracts. Classification comes only from
 * operation+role, and a PRIVATE role additionally names the one namespace its artifact path
 * may occupy. Public roles are project state CreatorCrate tracks, never cleanup material.
 *
 * A PRIVATE role's `liveTarget` is the field its WP3–WP6 producer persists for the live
 * project path the copy would publish to or be restored to: a staged output's destination,
 * a destination backup's destination, an original/source copy's source. (Prompt replaces
 * in place, so its stage's destination is the source path; its backup records no
 * destination.) A row whose target field is null can never be proven redundant.
 */
export const EVIDENCE_POLICY_CATALOG = Object.freeze({
  'workflow-prompt': Object.freeze({
    'stage-output': privateRole('workflow-prompt', `${INDEX}\\.png`, 'destinationPath'),
    'original-backup': privateRole('workflow-prompt', `${INDEX}\\.original`, 'sourcePath'),
    'published-output': PUBLIC_TRACKING,
  }),
  watermark: Object.freeze({
    'stage-output': privateRole('watermark', `${INDEX}\\.output`, 'destinationPath'),
    'destination-backup': privateRole('watermark', `${INDEX}\\.destination`, 'destinationPath'),
    'staged-original': privateRole('watermark', `${INDEX}\\.original`, 'sourcePath'),
    'published-output': PUBLIC_TRACKING,
  }),
  archive: Object.freeze({
    'archive-stage': privateRole('archive', `archive-${INDEX}\\.(?:zip|7z|cbz)`, 'destinationPath'),
    'destination-backup': privateRole('archive', `archive-${INDEX}\\.destination`, 'destinationPath'),
    'published-archive': PUBLIC_TRACKING,
  }),
  convert: Object.freeze({
    'stage-output': privateRole('convert', `${INDEX}\\.output`, 'destinationPath'),
    'original-backup': privateRole('convert', `${INDEX}\\.source`, 'sourcePath'),
    'staged-original': privateRole('convert', `${INDEX}\\.original`, 'sourcePath'),
    'published-output': PUBLIC_TRACKING,
    // Public project state (the Originals copy), never private cleanup material.
    'originals-copy': PUBLIC_TRACKING,
  }),
});

function policyFor(operation, artifactRole) {
  const roles = Object.hasOwn(EVIDENCE_POLICY_CATALOG, operation) ? EVIDENCE_POLICY_CATALOG[operation] : null;
  return roles && Object.hasOwn(roles, artifactRole) ? roles[artifactRole] : null;
}

/** 'private' | 'public-tracking' | 'unknown', from operation+role only. */
export function classifyEvidenceArtifact(operation, artifactRole) {
  return policyFor(operation, artifactRole)?.artifactClass ?? EVIDENCE_ARTIFACT_CLASS.unknown;
}

/** Whether a stored project-relative path is inside its PRIVATE role's own namespace. */
export function isInPrivateEvidenceNamespace(operation, artifactRole, artifactPath) {
  const policy = policyFor(operation, artifactRole);
  if (policy?.artifactClass !== EVIDENCE_ARTIFACT_CLASS.private || typeof artifactPath !== 'string') return false;
  const segments = artifactPath.split('/');
  return segments.length === 2 && segments[0] === policy.root && policy.name.test(segments[1]);
}

/**
 * Derived, non-authoritative: whether a row may undergo a fresh cleanup proof. Requires an
 * approved PRIVATE operation+role, a path in that role's namespace, `dispensable` lifecycle,
 * a recorded exact identity and the full expected content proof (size and SHA-256). It is
 * never deletion authority; the stored observation plays no part in it.
 */
export function isCleanupPolicyEligible(evidence) {
  return Boolean(evidence
    && isInPrivateEvidenceNamespace(evidence.operation, evidence.artifactRole, evidence.artifactPath)
    && evidence.lifecycle === 'dispensable'
    && evidence.identity !== null && evidence.identity !== undefined
    && evidence.expectedSize !== null && evidence.expectedSize !== undefined
    && typeof evidence.expectedSha256 === 'string');
}

export class ProcessingRecoveryEvidenceNotFoundError extends Error {
  constructor(message = 'Processing recovery evidence not found.') {
    super(message);
    this.name = 'ProcessingRecoveryEvidenceNotFoundError';
    this.code = 'RECOVERY_EVIDENCE_NOT_FOUND';
  }
}

export class ProcessingRecoveryEvidencePersistenceError extends Error {
  constructor(cause) {
    super('Processing recovery evidence metadata could not be settled. Retry cleanup to reconcile missing files.', { cause });
    this.name = 'ProcessingRecoveryEvidencePersistenceError';
    this.code = 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED';
  }
}

function cleanupBlockReason(evidence, group) {
  const artifactClass = classifyEvidenceArtifact(evidence.operation, evidence.artifactRole);
  if (artifactClass === EVIDENCE_ARTIFACT_CLASS.publicTracking) return 'public-tracking';
  if (artifactClass !== EVIDENCE_ARTIFACT_CLASS.private) return 'unknown-role';
  if (!isInPrivateEvidenceNamespace(evidence.operation, evidence.artifactRole, evidence.artifactPath)) return 'invalid-private-path';
  if (evidence.lifecycle !== 'dispensable') return evidence.lifecycle;
  if (group.checkpoint !== null) return 'checkpoint-active';
  if (!isCleanupPolicyEligible(evidence)) return 'proof-incomplete';
  return null;
}

// A new registry proof cannot inherit the filesystem snapshot of an older one.
function sameCleanupProof(left, right) {
  return ['mutationGroupId', 'operation', 'artifactRole', 'artifactPath', 'lifecycle', 'expectedSize', 'expectedSha256']
    .every((key) => left[key] === right[key])
    && ['dev', 'ino', 'birthtimeNs'].every((key) => left.identity?.[key] === right.identity?.[key]);
}

// UI-facing model: project-relative paths only, no absolute path and no raw identity.
function toViewModel(evidence, group) {
  return {
    evidenceId: evidence.evidenceId,
    projectId: evidence.projectId,
    assetId: evidence.assetId,
    operation: evidence.operation,
    runId: evidence.runId,
    mutationGroupId: evidence.mutationGroupId,
    itemKey: evidence.itemKey,
    checkpoint: group?.checkpoint ?? null,
    checkpointAt: group?.checkpointAt ?? null,
    artifactRole: evidence.artifactRole,
    lifecycle: evidence.lifecycle,
    observation: evidence.observation,
    observedAt: evidence.observedAt,
    retentionReason: evidence.retentionReason,
    artifactPath: evidence.artifactPath,
    sourcePath: evidence.sourcePath,
    destinationPath: evidence.destinationPath,
    identityRecorded: evidence.identity !== null,
    contentProofRecorded: evidence.expectedSize !== null && evidence.expectedSha256 !== null,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
    artifactClass: classifyEvidenceArtifact(evidence.operation, evidence.artifactRole),
    cleanupPolicyEligible: isCleanupPolicyEligible(evidence),
  };
}

function listViewModels(repository, projectId, rows, groups = repository.listMutationGroupsByProject(projectId)) {
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  return rows.map((row) => toViewModel(row, byId.get(row.mutationGroupId)));
}

/** SQLite-only Recovery Details, including checkpointed groups with no registered artifacts. */
export function listProjectRecoveryDetails(repository, projectId) {
  const rows = repository.listUnresolvedEvidenceByProject(projectId);
  const groups = repository.listMutationGroupsByProject(projectId);
  const registeredGroups = new Set(rows.map((row) => row.mutationGroupId));
  const entries = listViewModels(repository, projectId, rows, groups)
    .map((row) => ({ kind: 'evidence', ...row }));
  for (const group of groups) {
    if (group.checkpoint === null || registeredGroups.has(group.groupId)) continue;
    entries.push({
      kind: 'mutation-group',
      mutationGroupId: group.groupId,
      operation: group.operation,
      runId: group.runId,
      itemKey: group.itemKey,
      checkpoint: group.checkpoint,
      checkpointAt: group.checkpointAt,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      evidenceCount: 0,
    });
  }
  // Creation order is stable across observation refreshes; kind and ID break timestamp ties.
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  return entries.sort((left, right) => compare(left.createdAt, right.createdAt)
    || compare(left.kind, right.kind)
    || compare(left.evidenceId ?? left.mutationGroupId, right.evidenceId ?? right.mutationGroupId));
}

// The stored decimal identity as the exact bigint tuple the ownership helpers compare. The
// birth time is part of the tuple only when one was recorded.
function recordedExactIdentity(identity) {
  return {
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino),
    ...(identity.birthtimeNs !== null ? { birthtimeNs: BigInt(identity.birthtimeNs) } : {}),
  };
}

function lstatOrCode(absPath) {
  try {
    return { stats: fs.lstatSync(absPath, { bigint: true }) };
  } catch (err) {
    return { code: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'unavailable' };
  }
}

function inspectRegisteredPath(projectDir, artifactPath) {
  let absPath;
  try {
    // Trusted root + stored relative path, lexical containment and no symlink in any
    // intermediate component. The final component is classified below, never followed.
    absPath = resolveContainedAssetPath(projectDir, artifactPath.split('/').join(path.sep), {
      checkFinalSymlink: false,
    });
  } catch {
    return { code: 'unavailable' };
  }
  return { absPath, ...lstatOrCode(absPath) };
}

/**
 * The observation of one registered row under the trusted project root. Precedence:
 * cannot safely inspect → unavailable; absent → missing; no recorded identity → ownership-
 * unknown; a symlink/junction/non-regular object or a different exact identity → replaced
 * (never followed or hashed); same identity with mismatching content → changed; else present.
 * Content uses the hardened processing snapshot (identity → size/SHA → identity, post-hash
 * write fingerprint with its one conditional rehash for SMB metadata settling).
 */
function inspectEvidence(projectDir, evidence) {
  const first = inspectRegisteredPath(projectDir, evidence.artifactPath);
  if (!first.stats) return { observation: first.code };
  if (evidence.identity === null) return { observation: 'ownership-unknown' };
  const { absPath, stats } = first;
  const identity = recordedExactIdentity(evidence.identity);
  if (stats.isSymbolicLink() || !stats.isFile() || !matchesOwnedIdentity(stats, identity)) return { observation: 'replaced' };

  if (evidence.expectedSha256 === null) {
    // No hash was ever recorded: the exact identity is the strongest available proof.
    if (evidence.expectedSize !== null && stats.size !== BigInt(evidence.expectedSize)) return { observation: 'changed' };
    return { observation: 'present' };
  }
  const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, absPath, identity, {
    ...(evidence.expectedSize !== null ? { size: evidence.expectedSize } : {}),
    sha256: evidence.expectedSha256,
  });
  if (failure === null) return { observation: 'present', absPath, identity, fingerprint };
  return { observation: failedProofObservation(projectDir, evidence, identity, failure) };
}

function failedProofObservation(projectDir, evidence, identity, failure) {
  // A failed snapshot may hide disappearance, substitution or access failure during the
  // read. Recheck containment and the same path once before interpreting its failure.
  const after = inspectRegisteredPath(projectDir, evidence.artifactPath);
  if (!after.stats) return after.code;
  if (after.stats.isSymbolicLink() || !after.stats.isFile() || !matchesOwnedIdentity(after.stats, identity)) return 'replaced';
  return failure === 'content' ? 'changed' : 'unavailable';
}

function observeEvidence(projectDir, evidence) {
  return inspectEvidence(projectDir, evidence).observation;
}

/** Retention reasons a successful manual scan records when it resolves a private copy. */
export const MANUAL_SCAN_RETENTION = Object.freeze({
  // Another accepted live file holds exactly these bytes; awaiting explicit cleanup.
  redundant: 'manual-scan-redundant',
  // Nothing remains at the registered path to protect; awaiting explicit metadata retirement.
  artifactMissing: 'manual-scan-artifact-missing',
});

export class ProcessingRecoveryReconciliationError extends Error {
  constructor(cause) {
    super('Processing recovery state could not be settled after the manual scan. Retry the manual scan.', { cause });
    this.name = 'ProcessingRecoveryReconciliationError';
    this.code = 'RECOVERY_RECONCILIATION_FAILED';
  }
}

// A reconciliation call without the live, one-shot acceptance of a manual scan of this project.
export class ProcessingRecoveryReconciliationNotAuthorizedError extends Error {
  constructor() {
    super('Processing recovery state can only be settled by a successful manual scan.');
    this.name = 'ProcessingRecoveryReconciliationNotAuthorizedError';
    this.code = 'RECOVERY_RECONCILIATION_NOT_AUTHORIZED';
  }
}

/**
 * Whether the accepted live target currently holds exactly the expected bytes: 'match',
 * 'differs', 'missing' or 'unavailable'. The target is not CreatorCrate-owned: its current
 * exact identity is captured from one no-follow lstat only to bracket this read (hardened
 * snapshot: identity → size/SHA → identity, post-hash fingerprint with its one conditional
 * SMB-settling rehash) and is never persisted or adopted. A match proves only that another
 * accepted file holds these bytes; it grants no deletion authority over either path.
 */
function compareLiveTarget(projectDir, targetPath, expected) {
  if (typeof targetPath !== 'string') return 'unavailable';
  const target = inspectRegisteredPath(projectDir, targetPath);
  if (!target.stats) return target.code;
  if (target.stats.isSymbolicLink() || !target.stats.isFile()) return 'unavailable';
  const identity = {
    dev: target.stats.dev,
    ino: target.stats.ino,
    ...(isDurableBirthtimeNs(target.stats.birthtimeNs) ? { birthtimeNs: target.stats.birthtimeNs } : {}),
  };
  // A zero file ID (SMB without file IDs) cannot bracket the read: fail closed.
  if (!isKnownDirectoryIdentity(identity)) return 'unavailable';
  const { failure, unstable } = ownedPathContentSnapshot(projectDir, target.absPath, identity, expected);
  if (failure === null) return 'match';
  return failure === 'content' && !unstable ? 'differs' : 'unavailable';
}

/**
 * The manual-scan settlement of one PRIVATE row: { observation, lifecycle, retentionReason }
 * (retentionReason null keeps the operation's own reason). A copy becomes dispensable only
 * on positive proof that it holds nothing unique: its path is freshly absent, or it is
 * still its exact recorded artifact with its recorded bytes AND the accepted live target
 * holds those same bytes. Anything else retains it (an intent becomes recovery-critical);
 * a dispensable row only has its observation refreshed and never moves backward.
 * `projectDir` null means the project root could not be proven: nothing is inspected.
 */
function decidePrivateAfterManualScan(projectDir, row) {
  const policy = policyFor(row.operation, row.artifactRole);
  const inNamespace = isInPrivateEvidenceNamespace(row.operation, row.artifactRole, row.artifactPath);
  const observe = () => {
    if (!inNamespace) return row.observation;
    return projectDir === null ? 'unavailable' : observeEvidence(projectDir, row);
  };
  if (row.lifecycle === 'dispensable') return { observation: observe(), lifecycle: 'dispensable', retentionReason: null };
  const retain = (observation) => ({
    observation,
    lifecycle: row.lifecycle === 'intent' ? 'recovery-critical' : row.lifecycle,
    retentionReason: null,
  });
  if (!inNamespace || projectDir === null) return retain(observe());

  const proof = inspectEvidence(projectDir, row);
  if (proof.observation === 'missing') {
    return { observation: 'missing', lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.artifactMissing };
  }
  // Without a recorded hash (no fingerprint) the bytes cannot be compared with anything.
  if (proof.observation !== 'present' || !proof.fingerprint) return retain(proof.observation);
  const target = compareLiveTarget(projectDir, row[policy.liveTarget], {
    ...(row.expectedSize !== null ? { size: row.expectedSize } : {}),
    sha256: row.expectedSha256,
  });
  // The copy itself must still carry the bytes proven above after the target was read.
  const continuity = ownedPathContinuityFailure(proof.absPath, proof.identity, proof.fingerprint);
  if (continuity) return retain(failedProofObservation(projectDir, row, proof.identity, continuity));
  if (target !== 'match') return retain('present');
  return { observation: 'present', lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant };
}

// Registry fields a manual-scan decision was computed from; observation may differ.
const RECONCILED_FIELDS = Object.freeze([
  'mutationGroupId', 'operation', 'artifactRole', 'artifactPath', 'sourcePath', 'destinationPath',
  'lifecycle', 'retentionReason', 'expectedSize', 'expectedSha256',
]);

function sameReconciledRow(left, right) {
  return RECONCILED_FIELDS.every((key) => left[key] === right[key])
    && ['dev', 'ino', 'birthtimeNs'].every((key) => left.identity?.[key] === right.identity?.[key]);
}

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   projectRepository: { findById: (id: number) => object|null },
 *   projectDirectoryOwnershipRepository: object,
 *   projectsRoot: string,
 *   repository?: ReturnType<typeof createProcessingRecoveryEvidenceRepository>,
 *   projectOperationCoordinator?: object,
 *   processingRecoveryGate?: { clearRecoveryRequired(projectId: number): boolean },
 * }} deps `repository` and `processingRecoveryGate` default/must share `db`'s connection.
 */
export function createProcessingRecoveryEvidenceService({
  db, projectRepository, projectDirectoryOwnershipRepository, projectsRoot, repository, projectOperationCoordinator,
  processingRecoveryGate, manualScanAcceptance,
} = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('createProcessingRecoveryEvidenceService requires the application database.');
  }
  if (!projectRepository || typeof projectRepository.findById !== 'function') {
    throw new Error('createProcessingRecoveryEvidenceService requires a projectRepository dependency.');
  }
  const evidenceRepository = repository ?? createProcessingRecoveryEvidenceRepository(db);
  const ownershipVerifier = createProjectDirectoryOwnershipVerifier({
    ownershipRepository: projectDirectoryOwnershipRepository,
    projectsRoot,
  });

  function findRowAndGroup(projectId, evidenceId) {
    const row = evidenceRepository.findEvidence(projectId, evidenceId);
    const group = row && evidenceRepository.findMutationGroup(projectId, row.mutationGroupId);
    if (!row || !group) throw new ProcessingRecoveryEvidenceNotFoundError();
    return { row, group };
  }

  function cleanupRow(projectId, evidenceId) {
    const { row, group } = findRowAndGroup(projectId, evidenceId);
    const result = (status, reason, observation = row.observation) => ({
      evidenceId, artifactPath: row.artifactPath, status, reason, observation,
    });
    const blocked = cleanupBlockReason(row, group);
    if (blocked) return result('blocked', blocked);

    let verified;
    const project = projectRepository.findById(projectId);
    try {
      verified = ownershipVerifier.verifyProject(project);
    } catch {
      return result('retained', 'unavailable', 'unavailable');
    }
    const projectDir = verified.absPath;
    const safeInspection = () => {
      try {
        ownershipVerifier.assertContinuity(project, verified);
        return inspectRegisteredPath(projectDir, row.artifactPath);
      } catch {
        return { code: 'unavailable' };
      }
    };
    const settleObservation = (observation, removed = false) => {
      if (observation === 'missing') {
        // Absence is confirmed independently before retiring registry evidence.
        const final = safeInspection();
        if (!final.stats && final.code === 'missing') {
          return result(removed ? 'cleaned' : 'already-absent', removed ? 'removed' : 'already-absent', 'missing');
        }
        observation = final.stats ? observeEvidence(projectDir, row) : final.code;
      }
      return result('retained', observation === 'present' ? 'cleanup-failed' : observation, observation);
    };

    const proof = inspectEvidence(projectDir, row);
    if (proof.observation !== 'present') return settleObservation(proof.observation);
    // Refetch registry authority under the same operation lock before the final sweep.
    const current = findRowAndGroup(projectId, evidenceId);
    const currentBlock = cleanupBlockReason(current.row, current.group);
    if (currentBlock) return result('blocked', currentBlock);
    if (!sameCleanupProof(row, current.row)) return result('blocked', 'evidence-changed');
    const final = safeInspection();
    if (!final.stats) return settleObservation(final.code);
    const continuity = ownedPathContinuityFailure(final.absPath, proof.identity, proof.fingerprint);
    if (continuity) {
      return settleObservation(failedProofObservation(projectDir, row, proof.identity, continuity));
    }
    const removed = removeFileIfExactIdentityMatches(final.absPath, proof.identity, undefined, proof.fingerprint);
    // Success and failure both require a fresh same-path diagnosis. A foreign
    // replacement is never hashed or removed, even after a successful unlink.
    try {
      ownershipVerifier.assertContinuity(project, verified);
    } catch {
      return result('retained', 'unavailable', 'unavailable');
    }
    return settleObservation(observeEvidence(projectDir, row), removed);
  }

  return Object.freeze({
    /**
     * WP8B: the recovery side of a successful MANUAL scan, the user's acceptance of the
     * project's current files and index as the state to continue from. Only the manual
     * scan route reaches this, from the scanner's `afterScan` hook: it runs inside the
     * scanner's own project-operation section (the same shared coordinator WP7B cleanup and
     * processing use), never taking the lock itself.
     *
     * Authority is `acceptance`, the one-shot object the scanner mints for this project
     * only while its successful manual scan's `afterScan` runs (manual-scan-acceptance.js).
     * It is consumed before anything is read; a missing, foreign-project, stale or reused
     * acceptance is rejected with no state read or changed. An active project operation
     * alone (isActive) proves nothing and is only a secondary check.
     *
     * 1. Snapshot the project's evidence rows and mutation groups.
     * 2. With no transaction open, inspect each PRIVATE row and its accepted live target
     *    (decidePrivateAfterManualScan); public and unknown rows are not inspected.
     * 3. One short transaction: retire PUBLIC tracking rows (metadata only), persist private
     *    observations/transitions, clear every snapshot checkpoint, remove groups left with
     *    no checkpoint and no evidence, and clear the processing recovery gate. Any failure
     *    rolls all of it back (the gate stays set) and throws
     *    ProcessingRecoveryReconciliationError; the committed scan is not undone.
     *
     * Acceptance resolves mutation uncertainty, not recovery value: a private copy whose
     * bytes differ from the accepted live file stays protected while the checkpoint and the
     * gate clear. Nothing is unlinked, renamed, restored or written here; WP7B cleanup
     * remains the only deletion path. Unknown evidence is kept exactly as recorded.
     * @returns {{ publicTrackingRetired: number, privateMadeDispensable: number,
     *   privateRetained: number, groupsResolved: number, groupsRemoved: number }}
     */
    reconcileAfterManualScan(projectId, acceptance) {
      if (typeof processingRecoveryGate?.clearRecoveryRequired !== 'function') {
        throw new Error('reconcileAfterManualScan requires the processingRecoveryGate dependency.');
      }
      if (typeof manualScanAcceptance?.consume !== 'function' || !manualScanAcceptance.consume(projectId, acceptance)) {
        throw new ProcessingRecoveryReconciliationNotAuthorizedError();
      }
      if (typeof projectOperationCoordinator?.isActive !== 'function' || !projectOperationCoordinator.isActive(projectId)) {
        throw new Error('reconcileAfterManualScan must run inside the manual scan\'s project operation.');
      }
      const project = projectRepository.findById(projectId);
      if (!project) throw new ProcessingRecoveryEvidenceNotFoundError('Project not found.');
      const rows = evidenceRepository.listUnresolvedEvidenceByProject(projectId);
      const groups = evidenceRepository.listMutationGroupsByProject(projectId);

      const privateRows = rows.filter((row) => classifyEvidenceArtifact(row.operation, row.artifactRole)
        === EVIDENCE_ARTIFACT_CLASS.private);
      let verified = null;
      if (privateRows.length > 0) {
        try {
          verified = ownershipVerifier.verifyProject(project);
        } catch {
          // An unprovable root: every private copy is retained, nothing under it is read.
        }
      }
      const decide = (projectDir) => new Map(privateRows.map((row) => [row.evidenceId, decidePrivateAfterManualScan(projectDir, row)]));
      let decisions = decide(verified?.absPath ?? null);
      if (verified) {
        try {
          ownershipVerifier.assertContinuity(project, verified);
        } catch {
          // The root changed under the inspections: none of them proves anything.
          decisions = decide(null);
        }
      }

      const summary = {
        publicTrackingRetired: 0, privateMadeDispensable: 0, privateRetained: 0, groupsResolved: 0, groupsRemoved: 0,
      };
      try {
        db.transaction(() => {
          for (const row of rows) {
            const current = evidenceRepository.findEvidence(projectId, row.evidenceId);
            if (!current || !sameReconciledRow(row, current)) {
              throw new Error('Recovery evidence metadata changed before settlement.');
            }
            const artifactClass = classifyEvidenceArtifact(row.operation, row.artifactRole);
            if (artifactClass === EVIDENCE_ARTIFACT_CLASS.publicTracking) {
              // The accepted project state replaces what this row tracked; its file is untouched.
              if (!evidenceRepository.deleteEvidence(projectId, row.evidenceId)) throw new ProcessingRecoveryEvidenceNotFoundError();
              summary.publicTrackingRetired += 1;
              continue;
            }
            if (artifactClass !== EVIDENCE_ARTIFACT_CLASS.private) continue;
            const decision = decisions.get(row.evidenceId);
            const write = (ok) => { if (!ok) throw new ProcessingRecoveryEvidenceNotFoundError(); };
            write(evidenceRepository.setEvidenceObservation(projectId, row.evidenceId, decision.observation));
            if (decision.lifecycle !== row.lifecycle) {
              write(evidenceRepository.setEvidenceLifecycle(projectId, row.evidenceId, decision.lifecycle));
            }
            if (decision.retentionReason !== null) {
              write(evidenceRepository.setEvidenceRetentionReason(projectId, row.evidenceId, decision.retentionReason));
            }
            if (decision.lifecycle === 'dispensable' && row.lifecycle !== 'dispensable') summary.privateMadeDispensable += 1;
            else if (decision.lifecycle !== 'dispensable') summary.privateRetained += 1;
          }
          for (const group of groups) {
            if (group.checkpoint === null) continue;
            if (!evidenceRepository.clearMutationCheckpoint(projectId, group.groupId)) {
              throw new Error('Recovery mutation checkpoint changed before settlement.');
            }
            summary.groupsResolved += 1;
          }
          for (const group of groups) {
            if (evidenceRepository.findMutationGroup(projectId, group.groupId)?.checkpoint !== null) continue;
            if (evidenceRepository.listEvidenceByMutationGroup(projectId, group.groupId).length > 0) continue;
            if (!evidenceRepository.deleteMutationGroup(projectId, group.groupId)) {
              throw new Error('Resolved recovery mutation group could not be removed.');
            }
            summary.groupsRemoved += 1;
          }
          processingRecoveryGate.clearRecoveryRequired(projectId);
        })();
      } catch (cause) {
        throw new ProcessingRecoveryReconciliationError(cause);
      }
      return summary;
    },

    /**
     * Cleanup unique requested IDs in first-occurrence order under the application's
     * shared project lock. Validate the entire request before filesystem access. Reads,
     * hashes and unlinks run outside SQLite transactions; all observations and registry
     * deletions then commit together. A persistence failure rolls back metadata only:
     * removed files stay removed and a later retry reconciles their fresh absence.
     * @returns {Promise<{ evidenceId: string, artifactPath: string, status: string,
     *   reason: string, observation: string }[]>}
     */
    cleanupEvidence(projectId, evidenceIds) {
      if (!Array.isArray(evidenceIds)) throw new TypeError('cleanupEvidence requires an array of evidence IDs.');
      if (typeof projectOperationCoordinator?.runAsync !== 'function') {
        throw new Error('cleanupEvidence requires the shared asynchronous projectOperationCoordinator dependency.');
      }
      return projectOperationCoordinator.runAsync(projectId, () => {
        if (!projectRepository.findById(projectId)) throw new ProcessingRecoveryEvidenceNotFoundError('Project not found.');
        const ids = [...new Set(evidenceIds)];
        const registered = new Map(ids.map((id) => [id, findRowAndGroup(projectId, id)]));
        const results = ids.map((id) => cleanupRow(projectId, id));
        if (results.every((entry) => entry.status === 'blocked')) return results;
        try {
          db.transaction(() => {
            const cleanedGroups = new Set();
            for (const entry of results) {
              if (entry.status === 'blocked') continue;
              const { row, group } = findRowAndGroup(projectId, entry.evidenceId);
              if (cleanupBlockReason(row, group) || !sameCleanupProof(registered.get(entry.evidenceId).row, row)) {
                throw new Error('Recovery evidence metadata changed before settlement.');
              }
              if (entry.status === 'retained') {
                if (!evidenceRepository.setEvidenceObservation(projectId, entry.evidenceId, entry.observation)) {
                  throw new ProcessingRecoveryEvidenceNotFoundError();
                }
              } else {
                if (!evidenceRepository.deleteEvidence(projectId, entry.evidenceId)) {
                  throw new ProcessingRecoveryEvidenceNotFoundError();
                }
                cleanedGroups.add(row.mutationGroupId);
              }
            }
            for (const groupId of cleanedGroups) {
              const group = evidenceRepository.findMutationGroup(projectId, groupId);
              if (group?.checkpoint === null && evidenceRepository.listEvidenceByMutationGroup(projectId, groupId).length === 0
                && !evidenceRepository.deleteMutationGroup(projectId, groupId)) {
                throw new Error('Empty recovery evidence group could not be removed.');
              }
            }
          })();
        } catch (cause) {
          throw new ProcessingRecoveryEvidencePersistenceError(cause);
        }
        return results;
      });
    },

    /**
     * Every unresolved evidence row of the project with its mutation-group context and
     * derived policy fields. SQLite only: no filesystem access of any kind, so the stored
     * observation is shown as last recorded (possibly `unchecked`).
     */
    listProjectEvidence(projectId) {
      return listViewModels(evidenceRepository, projectId, evidenceRepository.listUnresolvedEvidenceByProject(projectId));
    },

    /**
     * Inspect exactly the requested registered rows of this project and record what was
     * observed. Every ID is looked up within the project first: an unknown or foreign ID
     * rejects the whole request (RECOVERY_EVIDENCE_NOT_FOUND, same error either way) before
     * any filesystem access. All rows are inspected with no transaction open; the
     * observations are then persisted in one short transaction, so they all commit or none
     * does (a failed write propagates and leaves every stored observation unchanged). Only
     * observation/observedAt (and the row's updatedAt) change. The result is advisory.
     * @returns {ReturnType<typeof toViewModel>[]} the refreshed rows, in request order
     */
    refreshEvidence(projectId, evidenceIds) {
      if (!Array.isArray(evidenceIds)) throw new TypeError('refreshEvidence requires an array of evidence IDs.');
      const project = projectRepository.findById(projectId);
      if (!project) throw new ProcessingRecoveryEvidenceNotFoundError('Project not found.');
      const ids = [...new Set(evidenceIds)];
      const rows = ids.map((evidenceId) => evidenceRepository.findEvidence(projectId, evidenceId));
      if (rows.some((row) => row === null)) throw new ProcessingRecoveryEvidenceNotFoundError();
      if (rows.length === 0) return [];

      let projectDir = null;
      try {
        projectDir = ownershipVerifier.verifyProject(project).absPath;
      } catch {
        // The project root (or its share) cannot be proven: nothing under it is inspected.
      }
      const observations = rows.map((row) => (projectDir === null ? 'unavailable' : observeEvidence(projectDir, row)));

      db.transaction(() => {
        rows.forEach((row, index) => {
          if (!evidenceRepository.setEvidenceObservation(projectId, row.evidenceId, observations[index])) {
            throw new ProcessingRecoveryEvidenceNotFoundError();
          }
        });
      })();

      const refreshed = ids.map((evidenceId) => evidenceRepository.findEvidence(projectId, evidenceId));
      return listViewModels(evidenceRepository, projectId, refreshed.filter(Boolean));
    },
  });
}
