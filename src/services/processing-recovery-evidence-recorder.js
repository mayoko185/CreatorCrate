import { createProcessingRecoveryEvidenceRepository } from '../data/processing-recovery-evidence-repository.js';
import { AssetProcessingError } from './asset-processing-contracts.js';

/**
 * Processing recovery evidence recorder — the one ordering-enforcing seam through
 * which processing operations write recovery evidence. It performs no filesystem
 * work of its own: every create, mutation and cleanup is a caller callback, and
 * the recorder only decides whether that callback may run.
 *
 * Ordering contract (each step durable before the next may begin):
 *   1. startMutationGroup: one group per item of one run. `runId` is the processing
 *      job ID (`onProgress.jobId`, also the application-log correlationId).
 *   2. createArtifact: the evidence intent row is committed before `create` runs;
 *      the descriptor-owned exact identity is committed from `onOwned`, before the
 *      creating call writes a byte and before anything later may advance.
 *   3. beginMutation: the group checkpoint is committed before `mutate` runs.
 *   4. Finalization (markRecoveryCritical / markDispensable) targets one evidence
 *      row of this group and may run inside runInTransaction together with the
 *      caller's asset/index writes, so both commit or neither does.
 *   5. resolveMutation: the only way a checkpoint is cleared, in autocommit only and
 *      after the caller's asset/evidence finalization has committed. A failure between
 *      that commit and resolution leaves a stale but conservative checkpoint.
 *
 * Checkpoint semantics: ANY non-null checkpoint means a public/project mutation may
 * have begun. A later checkpoint value only refines diagnostics and never makes the
 * group look harmless. Lifecycle, observation, retention changes and transaction
 * commits never clear it; only an explicit resolveMutation, called once
 * operation-specific code has positively resolved the mutation, does.
 *
 * Authority: SQLite rows never authorize a filesystem deletion. After a failed
 * registry write the only cleanup attempted is the caller's `discardOwned`, handed
 * the exact in-memory identity captured from the creating descriptor.
 *
 * Failures (AssetProcessingError):
 *   - RECOVERY_EVIDENCE_PERSISTENCE_FAILED: a registry write failed and nothing is
 *     left unresolved (nothing was created, or the created owned artifact was
 *     removed under its exact identity). `evidenceStage` says where.
 *   - RECOVERY_REQUIRED: a registry write failed after an owned artifact was created
 *     and its removal could not be proven, or a checkpointed (public/project) create
 *     left a created-but-unclaimed path. The processing job hook retains the project's
 *     existing recovery gate for this code; no other gate is involved.
 * The raw SQLite error is only ever the `cause`.
 *
 * Callback contract: no ordering guarantee extends past a callback's synchronous work
 * or, for `create`, past its awaited settlement. `create` hooks are inert once
 * createArtifact has settled; `mutate` is never treated as completed (only
 * resolveMutation clears its checkpoint); `discardOwned` proves removal only by
 * returning literal `true`, so a returned Promise is never proof.
 */

export const RECOVERY_EVIDENCE_PERSISTENCE_FAILED = 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED';

// Where a registry write failed. Internal diagnostics, never a client contract.
export const RECOVERY_EVIDENCE_STAGE = Object.freeze({
  group: 'group',
  intent: 'intent',
  identity: 'identity',
  checkpoint: 'checkpoint',
  contentProof: 'content-proof',
  finalization: 'finalization',
  resolution: 'resolution',
});

function persistenceFailed(stage, cause, { ownedArtifactRemoved = false } = {}) {
  return Object.assign(
    new AssetProcessingError('Processing recovery evidence could not be recorded.', {
      code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED,
      ...(cause !== undefined ? { cause } : {}),
    }),
    { evidenceStage: stage, ownedArtifactRemoved },
  );
}

function recoveryRequired(stage, cause, {
  message = 'Processing recovery is required: recovery evidence could not be recorded.',
} = {}) {
  return Object.assign(
    new AssetProcessingError(message, {
      code: 'RECOVERY_REQUIRED',
      ...(cause !== undefined ? { cause } : {}),
    }),
    { evidenceStage: stage, ownedArtifactRemoved: false },
  );
}

// A write that reports no change did not persist what the caller relies on.
function write(stage, run) {
  let changed;
  try {
    changed = run();
  } catch (err) {
    throw persistenceFailed(stage, err);
  }
  if (changed === false) throw persistenceFailed(stage);
  return changed;
}

// A declared async (generator) function starts work that cannot be part of a synchronous
// SQLite transaction, so it is recognized before it is invoked.
function isAsyncFunction(fn) {
  const tag = Object.prototype.toString.call(fn);
  return tag === '[object AsyncFunction]' || tag === '[object AsyncGeneratorFunction]';
}

/**
 * @param {{ db: import('better-sqlite3').Database, repository?: ReturnType<typeof createProcessingRecoveryEvidenceRepository> }} deps
 *   `repository` defaults to one over `db`; tests inject a failing one. It must use
 *   the same connection as `db` (and as the asset repository) for runInTransaction
 *   to be one transaction.
 */
export function createProcessingRecoveryEvidenceRecorder({ db, repository } = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('createProcessingRecoveryEvidenceRecorder requires the application database.');
  }
  const evidence = repository ?? createProcessingRecoveryEvidenceRepository(db);

  // A step that must be durable before filesystem work may not run inside a caller's
  // transaction: its write would not be committed until that transaction ends.
  function assertAutocommit(step) {
    if (db.inTransaction) {
      throw new Error(`Processing recovery ${step} must be committed before filesystem work; it cannot run inside a transaction.`);
    }
  }

  function createGroupHandle(group) {
    const { projectId, groupId } = group;
    // Whether this group's non-null checkpoint is durable (public/project state may be
    // mutating). A new group never has one; only resolveMutation clears it.
    let checkpointed = false;

    function markCheckpoint(checkpoint) {
      write(RECOVERY_EVIDENCE_STAGE.checkpoint, () => evidence.markMutationCheckpoint(projectId, groupId, checkpoint));
      checkpointed = true;
    }

    function requireOwnEvidence(stage, evidenceId) {
      let row;
      try {
        row = evidence.findEvidence(projectId, evidenceId);
      } catch (err) {
        throw persistenceFailed(stage, err);
      }
      // Per-group isolation: another group's (or project's) row is never finalized here.
      if (!row || row.mutationGroupId !== groupId) {
        throw persistenceFailed(stage, new Error('Evidence does not belong to this mutation group.'));
      }
    }

    function finalize(evidenceId, lifecycle, retentionReason) {
      const stage = RECOVERY_EVIDENCE_STAGE.finalization;
      // Nested inside runInTransaction this is a savepoint of the caller's transaction.
      db.transaction(() => {
        requireOwnEvidence(stage, evidenceId);
        if (retentionReason !== undefined) {
          write(stage, () => evidence.setEvidenceRetentionReason(projectId, evidenceId, retentionReason));
        }
        write(stage, () => evidence.setEvidenceLifecycle(projectId, evidenceId, lifecycle));
      })();
    }

    return Object.freeze({
      projectId,
      groupId,
      runId: group.runId,
      operation: group.operation,
      itemKey: group.itemKey,

      /**
       * Intent → create → owned identity, in that durable order.
       *
       * `create({ onCreated, onOwned })` performs the exclusive create (e.g. via
       * createOwnedFile) and must pass both hooks through; it may wrap them. `onOwned`
       * persists the exact identity synchronously and throws if it cannot, so the
       * creating call stops before writing. `discardOwned(exactIdentity)` is the
       * ownership-authorized removal of that one artifact (e.g.
       * removeFileIfExactIdentityMatches) and must return true only on proven removal.
       *
       * A `checkpoint` is marked after the intent and before `create`, for an artifact
       * whose creation is itself a public/project mutation.
       *
       * Created-but-unclaimed (onCreated without a successful onOwned, whether `create`
       * throws or returns): the pathname is never adopted or removed and no identity is
       * invented; the intent row stays unresolved (identity null) and ownership-unknown
       * is recorded where possible. If this group is checkpointed, the unclaimed path may
       * be public/project state, so the result is RECOVERY_REQUIRED (original failure as
       * `cause`, a failed observation write only as `observationFailure`). Otherwise the
       * original failure is rethrown.
       *
       * `onOwned` refuses to persist identity inside a surrounding transaction (it would
       * not be durable before bytes are written); that refusal is handled exactly like a
       * failed identity write. Hooks invoked after createArtifact settled throw.
       *
       * @returns {Promise<{ evidenceId: string, exactIdentity: { dev: bigint, ino: bigint }, value: any }>}
       */
      async createArtifact({ intent, checkpoint, create, discardOwned }) {
        if (typeof create !== 'function' || typeof discardOwned !== 'function') {
          throw new TypeError('createArtifact requires create and discardOwned callbacks.');
        }
        assertAutocommit('evidence intent');
        const row = write(RECOVERY_EVIDENCE_STAGE.intent, () => evidence.createEvidence({
          ...intent, projectId, mutationGroupId: groupId, identity: null, lifecycle: 'intent',
        }));
        const { evidenceId } = row;
        if (checkpoint !== undefined) markCheckpoint(checkpoint);

        let settled = false;
        let created = false;
        let exactIdentity = null;
        let identityPersisted = false;
        let identityFailure = null;
        function assertActive() {
          if (settled) throw new Error('createArtifact hooks cannot be used after createArtifact settled.');
        }
        const hooks = {
          onCreated() {
            assertActive();
            created = true;
          },
          onOwned(identity) {
            assertActive();
            // In-memory ownership first: it stays the cleanup authority whatever happens next.
            exactIdentity = identity;
            try {
              if (db.inTransaction) {
                throw persistenceFailed(RECOVERY_EVIDENCE_STAGE.identity, new Error(
                  'Processing recovery evidence identity must be committed before the file is written; it cannot be attached inside a transaction.',
                ));
              }
              write(RECOVERY_EVIDENCE_STAGE.identity, () => evidence.attachEvidenceIdentity(projectId, evidenceId, identity));
              identityPersisted = true;
            } catch (err) {
              identityFailure = err;
              throw err;
            }
          },
        };

        let value;
        let createError = null;
        try {
          value = await create(hooks);
        } catch (err) {
          createError = err;
        } finally {
          settled = true;
        }

        if (identityFailure) {
          // Never continue on a transient-only mapping. Remove only what the exact
          // in-memory identity authorizes; unproven removal fails closed.
          let removed = false;
          try {
            removed = discardOwned(exactIdentity) === true;
          } catch {
            removed = false;
          }
          if (!removed) throw recoveryRequired(RECOVERY_EVIDENCE_STAGE.identity, identityFailure.cause ?? identityFailure);
          try {
            evidence.deleteEvidence(projectId, evidenceId);
          } catch {
            // A leftover intent row without identity claims nothing and authorizes nothing.
          }
          throw persistenceFailed(RECOVERY_EVIDENCE_STAGE.identity, identityFailure.cause ?? identityFailure, {
            ownedArtifactRemoved: true,
          });
        }
        const unowned = createError === null && !identityPersisted
          ? new Error('createArtifact create() completed without establishing exact ownership.')
          : null;
        if (created && !identityPersisted) {
          // Created but never claimed: neither adopted nor removed, no identity invented.
          let observationFailure = null;
          try {
            evidence.setEvidenceObservation(projectId, evidenceId, 'ownership-unknown');
          } catch (err) {
            // The unresolved intent row (identity null) already records the attempt.
            observationFailure = err;
          }
          if (checkpointed) {
            // A secondary registry failure never downgrades the unresolved public path.
            throw Object.assign(recoveryRequired(RECOVERY_EVIDENCE_STAGE.identity, createError ?? unowned, {
              message: 'Processing recovery is required: a created file could not be claimed.',
            }), observationFailure ? { observationFailure } : {});
          }
        }
        if (createError) throw createError;
        if (unowned) throw unowned;
        return { evidenceId, exactIdentity, value };
      },

      /**
       * Durably mark "mutation may have begun", then run `mutate`. If the checkpoint
       * cannot be persisted, `mutate` never runs. Its return value (Promise or not) is
       * passed through and never treated as a completed mutation: the checkpoint stays
       * until an explicit resolveMutation.
       */
      beginMutation(checkpoint, mutate) {
        if (typeof mutate !== 'function') throw new TypeError('beginMutation requires a mutate callback.');
        assertAutocommit('mutation checkpoint');
        markCheckpoint(checkpoint);
        return mutate();
      },

      /** Record the expected content proof of one of this group's artifacts. */
      recordContentProof(evidenceId, { expectedSize = null, expectedSha256 = null } = {}) {
        const stage = RECOVERY_EVIDENCE_STAGE.contentProof;
        requireOwnEvidence(stage, evidenceId);
        write(stage, () => evidence.updateEvidenceContentProof(projectId, evidenceId, { expectedSize, expectedSha256 }));
      },

      /** Retain one artifact as recovery-critical. Row identity/group/asset are unchanged. */
      markRecoveryCritical(evidenceId, { retentionReason } = {}) {
        finalize(evidenceId, 'recovery-critical', retentionReason);
      },

      /** Mark one artifact dispensable residue. Deletes nothing; cleanup is a later step. */
      markDispensable(evidenceId, { retentionReason } = {}) {
        finalize(evidenceId, 'dispensable', retentionReason);
      },

      /**
       * Explicitly clear this group's checkpoint once the caller has positively resolved
       * the mutation, in autocommit only: a clear inside an open transaction is not
       * durable (a rollback restores the checkpoint), so it is refused, and resolution is
       * never part of runInTransaction. The handle stops treating the group as
       * checkpointed only after the cleared checkpoint is observed committed; on any
       * failure the checkpoint stays conservative, durably and in memory.
       * @returns {boolean} false when no checkpoint was set
       */
      resolveMutation() {
        const stage = RECOVERY_EVIDENCE_STAGE.resolution;
        if (db.inTransaction) {
          throw persistenceFailed(stage, new Error(
            'Processing recovery mutation resolution must be committed on its own; it cannot run inside a transaction.',
          ));
        }
        let cleared;
        let stored;
        try {
          cleared = evidence.clearMutationCheckpoint(projectId, groupId);
          stored = evidence.findMutationGroup(projectId, groupId);
        } catch (err) {
          throw persistenceFailed(stage, err);
        }
        if (db.inTransaction || !stored || stored.checkpoint !== null) throw persistenceFailed(stage);
        checkpointed = false;
        return cleared;
      },
    });
  }

  return Object.freeze({
    /** Durably create one mutation group (no checkpoint) before any filesystem work. */
    startMutationGroup({ projectId, operation, runId, itemKey = null }) {
      assertAutocommit('mutation group');
      const group = write(RECOVERY_EVIDENCE_STAGE.group, () => evidence.createMutationGroup({
        projectId, operation, runId, itemKey,
      }));
      return createGroupHandle(group);
    },

    /**
     * Run `fn` synchronously in one SQLite transaction on the shared connection. Asset
     * repository methods called inside it (their own transactions nest as savepoints)
     * and evidence finalization commit together, or roll back together if `fn` throws.
     * Filesystem rollback stays with the caller, after this returns or throws.
     *
     * `fn` must be synchronous and must not schedule asynchronous continuation work:
     * nothing after its return can be part of the transaction. A declared async function
     * is refused before it runs; a function that returns a Promise/thenable has its
     * synchronous writes rolled back and is refused, but work it already scheduled
     * cannot be cancelled — that is a contract violation by the caller.
     */
    runInTransaction(fn) {
      if (typeof fn !== 'function' || isAsyncFunction(fn)) {
        throw new TypeError('runInTransaction requires a synchronous function.');
      }
      return db.transaction(() => {
        const result = fn();
        if (result && typeof result.then === 'function') {
          throw new TypeError('runInTransaction requires a synchronous function.');
        }
        return result;
      })();
    },
  });
}
