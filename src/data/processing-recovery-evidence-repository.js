import { randomUUID } from 'node:crypto';

/**
 * Processing recovery evidence repository — the SQLite serving authority for
 * what CreatorCrate believes about private evidence a processing run created
 * or retained. It performs no filesystem work and never decides whether a
 * deletion is safe: a row only names what a later exact-identity check of the
 * filesystem may prove, and only that proof authorizes cleanup.
 *
 * A mutation group is one unit of processing work (one item of one run). Its
 * checkpoint records, before a public mutation begins, which mutation may have
 * started; it is independent of any artifact's identity. Evidence rows belong
 * to exactly one group of the same project and exist only while unresolved:
 * a positively cleaned artifact's row is deleted, not kept as history.
 *
 * Exact filesystem identity (dev, ino, birth time in ns) is accepted as a
 * bigint or unsigned decimal string and always returned as a decimal string;
 * a Number is rejected because it may already have lost precision.
 *
 * Every read and write is scoped by project ID. All statements run on the
 * caller's connection, so a caller's `db.transaction(...)` includes them.
 */

export const PROCESSING_RECOVERY_OPERATIONS = Object.freeze(['workflow-prompt', 'watermark', 'archive', 'convert']);
export const PROCESSING_RECOVERY_LIFECYCLES = Object.freeze(['intent', 'recovery-critical', 'dispensable']);
export const PROCESSING_RECOVERY_OBSERVATIONS = Object.freeze([
  'unchecked', 'present', 'missing', 'replaced', 'changed', 'unavailable', 'ownership-unknown',
]);
export const PROCESSING_RECOVERY_CHECKPOINTS = Object.freeze(['public-create', 'replace', 'unlink', 'restore']);

export class InvalidProcessingRecoveryEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidProcessingRecoveryEvidenceError';
  }
}

const invalid = (message) => new InvalidProcessingRecoveryEvidenceError(message);

// Opaque identifiers (run, group, evidence IDs): UUIDs today, never paths.
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Operation-specific roles and reasons stay open-ended (no migration per new
// value) but constrained to short lowercase kebab tokens.
const LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

function requireProjectId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('projectId must be a positive integer.');
  return value;
}

function optionalAssetId(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('assetId must be a positive integer or null.');
  return value;
}

function requireOpaqueId(value, name) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw invalid(`${name} is invalid.`);
  return value;
}

function requireEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw invalid(`${name} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function requireLabel(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !LABEL.test(value)) throw invalid(`${name} is invalid.`);
  return value;
}

function optionalItemKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\0')) {
    throw invalid('itemKey is invalid.');
  }
  return value;
}

// Project-relative, forward-slash path with no empty, `.` or `..` segment. It
// is only ever resolved inside the already-trusted project root.
function relativePath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`${name} must be a normalized project-relative path.`);
  }
  return value;
}

function optionalRelativePath(value, name) {
  return value === undefined || value === null ? null : relativePath(value, name);
}

function exactDecimal(value, name, { positive, max }) {
  let decimal;
  if (typeof value === 'bigint') {
    decimal = value.toString();
  } else if (typeof value === 'string' && DECIMAL.test(value)) {
    decimal = value;
  } else {
    throw invalid(`${name} must be an exact bigint or unsigned decimal string.`);
  }
  const exact = BigInt(decimal);
  if (exact < 0n || (positive && exact === 0n) || (max !== undefined && exact > max)) {
    throw invalid(`${name} is out of range.`);
  }
  return decimal;
}

// Matches the processing ownership contract: dev may be 0, but a zero ino
// (e.g. SMB) never proves identity, so it is never recorded as one.
function exactIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw invalid('identity is required.');
  const dev = exactDecimal(identity.dev, 'identity.dev', { positive: false, max: MAX_UINT64 });
  const ino = exactDecimal(identity.ino, 'identity.ino', { positive: true, max: MAX_UINT64 });
  const birthtimeNs = identity.birthtimeNs === undefined || identity.birthtimeNs === null
    ? null
    : exactDecimal(identity.birthtimeNs, 'identity.birthtimeNs', { positive: true });
  if (birthtimeNs !== null && birthtimeNs.length > 30) throw invalid('identity.birthtimeNs is out of range.');
  return { dev, ino, birthtimeNs };
}

function optionalSize(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('expectedSize must be a non-negative integer or null.');
  return value;
}

function optionalSha256(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalid('expectedSha256 must be lowercase hex SHA-256 or null.');
  return value;
}

function mapGroup(row) {
  if (!row) return null;
  return {
    groupId: row.group_id,
    projectId: row.project_id,
    operation: row.operation,
    runId: row.run_id,
    itemKey: row.item_key,
    checkpoint: row.checkpoint,
    checkpointAt: row.checkpoint_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvidence(row) {
  if (!row) return null;
  return {
    evidenceId: row.evidence_id,
    projectId: row.project_id,
    mutationGroupId: row.mutation_group_id,
    operation: row.operation,
    runId: row.run_id,
    itemKey: row.item_key,
    assetId: row.asset_id,
    artifactRole: row.artifact_role,
    retentionReason: row.retention_reason,
    artifactPath: row.artifact_path,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    identity: row.identity_dev === null
      ? null
      : { dev: row.identity_dev, ino: row.identity_ino, birthtimeNs: row.identity_birthtime_ns },
    expectedSize: row.expected_size,
    expectedSha256: row.expected_sha256,
    lifecycle: row.lifecycle,
    observation: row.observation,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const GROUP_SELECT = `
  SELECT group_id, project_id, operation, run_id, item_key, checkpoint, checkpoint_at, created_at, updated_at
  FROM processing_recovery_mutation_groups
`;

const EVIDENCE_SELECT = `
  SELECT e.evidence_id, e.project_id, e.mutation_group_id, g.operation, g.run_id, g.item_key,
         e.asset_id, e.artifact_role, e.retention_reason, e.artifact_path, e.source_path,
         e.destination_path, e.identity_dev, e.identity_ino, e.identity_birthtime_ns,
         e.expected_size, e.expected_sha256, e.lifecycle, e.observation, e.observed_at,
         e.created_at, e.updated_at
  FROM processing_recovery_evidence e
  JOIN processing_recovery_mutation_groups g
    ON g.group_id = e.mutation_group_id AND g.project_id = e.project_id
`;

const EVIDENCE_ORDER = 'ORDER BY e.created_at ASC, e.evidence_id ASC';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => Date, generateId?: () => string }} [options]
 */
export function createProcessingRecoveryEvidenceRepository(db, {
  now = () => new Date(), generateId = randomUUID,
} = {}) {
  const insertGroupStmt = db.prepare(`
    INSERT INTO processing_recovery_mutation_groups (
      group_id, project_id, operation, run_id, item_key, checkpoint, checkpoint_at, created_at, updated_at
    )
    VALUES (@groupId, @projectId, @operation, @runId, @itemKey, NULL, NULL, @now, @now)
  `);
  const findGroupStmt = db.prepare(`${GROUP_SELECT} WHERE project_id = ? AND group_id = ?`);
  const listGroupsByProjectStmt = db.prepare(
    `${GROUP_SELECT} WHERE project_id = ? ORDER BY created_at ASC, group_id ASC`,
  );
  const listGroupsByRunStmt = db.prepare(
    `${GROUP_SELECT} WHERE project_id = ? AND run_id = ? ORDER BY created_at ASC, group_id ASC`,
  );
  const markCheckpointStmt = db.prepare(`
    UPDATE processing_recovery_mutation_groups
    SET checkpoint = @checkpoint, checkpoint_at = @now, updated_at = @now
    WHERE project_id = @projectId AND group_id = @groupId
  `);
  const clearCheckpointStmt = db.prepare(`
    UPDATE processing_recovery_mutation_groups
    SET checkpoint = NULL, checkpoint_at = NULL, updated_at = @now
    WHERE project_id = @projectId AND group_id = @groupId AND checkpoint IS NOT NULL
  `);
  // A group that still has evidence is never removed: its evidence must be
  // resolved (deleted) first by an explicit caller.
  const deleteGroupStmt = db.prepare(`
    DELETE FROM processing_recovery_mutation_groups
    WHERE project_id = ? AND group_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM processing_recovery_evidence
        WHERE mutation_group_id = processing_recovery_mutation_groups.group_id
      )
  `);

  const insertEvidenceStmt = db.prepare(`
    INSERT INTO processing_recovery_evidence (
      evidence_id, project_id, mutation_group_id, asset_id, artifact_role, retention_reason,
      artifact_path, source_path, destination_path, identity_dev, identity_ino, identity_birthtime_ns,
      expected_size, expected_sha256, lifecycle, observation, observed_at, created_at, updated_at
    )
    VALUES (
      @evidenceId, @projectId, @mutationGroupId, @assetId, @artifactRole, @retentionReason,
      @artifactPath, @sourcePath, @destinationPath, @dev, @ino, @birthtimeNs,
      @expectedSize, @expectedSha256, @lifecycle, 'unchecked', NULL, @now, @now
    )
  `);
  const assetInProjectStmt = db.prepare('SELECT 1 FROM assets WHERE id = ? AND project_id = ?').pluck();
  const findEvidenceStmt = db.prepare(`${EVIDENCE_SELECT} WHERE e.project_id = ? AND e.evidence_id = ?`);
  const listEvidenceByProjectStmt = db.prepare(`${EVIDENCE_SELECT} WHERE e.project_id = ? ${EVIDENCE_ORDER}`);
  const listEvidenceByRunStmt = db.prepare(
    `${EVIDENCE_SELECT} WHERE e.project_id = ? AND g.run_id = ? ${EVIDENCE_ORDER}`,
  );
  const listEvidenceByGroupStmt = db.prepare(
    `${EVIDENCE_SELECT} WHERE e.project_id = ? AND e.mutation_group_id = ? ${EVIDENCE_ORDER}`,
  );
  // An established identity is never overwritten: a different object is a
  // different artifact and needs its own row.
  const attachIdentityStmt = db.prepare(`
    UPDATE processing_recovery_evidence
    SET identity_dev = @dev, identity_ino = @ino, identity_birthtime_ns = @birthtimeNs, updated_at = @now
    WHERE project_id = @projectId AND evidence_id = @evidenceId AND identity_dev IS NULL
  `);
  const updateContentProofStmt = db.prepare(`
    UPDATE processing_recovery_evidence
    SET expected_size = @expectedSize, expected_sha256 = @expectedSha256, updated_at = @now
    WHERE project_id = @projectId AND evidence_id = @evidenceId
  `);
  // Retention context is descriptive only; identity, asset, and group stay put.
  const setRetentionReasonStmt = db.prepare(`
    UPDATE processing_recovery_evidence
    SET retention_reason = @retentionReason, updated_at = @now
    WHERE project_id = @projectId AND evidence_id = @evidenceId
  `);
  const setLifecycleStmt = db.prepare(`
    UPDATE processing_recovery_evidence
    SET lifecycle = @lifecycle, updated_at = @now
    WHERE project_id = @projectId AND evidence_id = @evidenceId
  `);
  const setObservationStmt = db.prepare(`
    UPDATE processing_recovery_evidence
    SET observation = @observation,
        observed_at = CASE WHEN @observation = 'unchecked' THEN NULL ELSE @now END,
        updated_at = @now
    WHERE project_id = @projectId AND evidence_id = @evidenceId
  `);
  const deleteEvidenceStmt = db.prepare(
    'DELETE FROM processing_recovery_evidence WHERE project_id = ? AND evidence_id = ?',
  );

  const timestamp = () => now().toISOString();
  const evidenceKey = (projectId, evidenceId) => ({
    projectId: requireProjectId(projectId),
    evidenceId: requireOpaqueId(evidenceId, 'evidenceId'),
  });
  // The asset FK only proves existence; evidence may link only its own
  // project's asset. The same error for absent and foreign assets reveals
  // nothing about another project.
  const projectAssetId = (projectId, assetId) => {
    const id = optionalAssetId(assetId);
    if (id !== null && !assetInProjectStmt.get(id, projectId)) throw invalid('assetId is not an asset of this project.');
    return id;
  };
  const groupKey = (projectId, groupId) => ({
    projectId: requireProjectId(projectId),
    groupId: requireOpaqueId(groupId, 'groupId'),
  });

  return {
    /** Create one mutation group (no checkpoint yet). */
    createMutationGroup({ projectId, operation, runId, itemKey = null }) {
      const params = {
        groupId: requireOpaqueId(generateId(), 'groupId'),
        projectId: requireProjectId(projectId),
        operation: requireEnum(operation, PROCESSING_RECOVERY_OPERATIONS, 'operation'),
        runId: requireOpaqueId(runId, 'runId'),
        itemKey: optionalItemKey(itemKey),
        now: timestamp(),
      };
      insertGroupStmt.run(params);
      return mapGroup(findGroupStmt.get(params.projectId, params.groupId));
    },

    findMutationGroup(projectId, groupId) {
      const key = groupKey(projectId, groupId);
      return mapGroup(findGroupStmt.get(key.projectId, key.groupId));
    },

    listMutationGroupsByProject(projectId) {
      return listGroupsByProjectStmt.all(requireProjectId(projectId)).map(mapGroup);
    },

    listMutationGroupsByRun(projectId, runId) {
      return listGroupsByRunStmt.all(requireProjectId(projectId), requireOpaqueId(runId, 'runId')).map(mapGroup);
    },

    /**
     * Durably record, before it begins, which public mutation this group may
     * have started. A failed write throws, so the caller can fail closed.
     * @returns {boolean} false when the group does not exist in this project
     */
    markMutationCheckpoint(projectId, groupId, checkpoint) {
      return markCheckpointStmt.run({
        ...groupKey(projectId, groupId),
        checkpoint: requireEnum(checkpoint, PROCESSING_RECOVERY_CHECKPOINTS, 'checkpoint'),
        now: timestamp(),
      }).changes > 0;
    },

    /** @returns {boolean} false when there was no checkpoint to clear */
    clearMutationCheckpoint(projectId, groupId) {
      return clearCheckpointStmt.run({ ...groupKey(projectId, groupId), now: timestamp() }).changes > 0;
    },

    /** @returns {boolean} false when absent here or when evidence still references it */
    deleteMutationGroup(projectId, groupId) {
      const key = groupKey(projectId, groupId);
      return deleteGroupStmt.run(key.projectId, key.groupId).changes > 0;
    },

    /**
     * Record evidence, by default as an `intent` before the artifact has an
     * established exact identity. The group must belong to the same project.
     */
    createEvidence({
      projectId, mutationGroupId, assetId = null, artifactRole, retentionReason,
      artifactPath, sourcePath = null, destinationPath = null, identity = null,
      expectedSize = null, expectedSha256 = null, lifecycle = 'intent',
    }) {
      const exact = identity === null || identity === undefined
        ? { dev: null, ino: null, birthtimeNs: null }
        : exactIdentity(identity);
      const validProjectId = requireProjectId(projectId);
      const params = {
        evidenceId: requireOpaqueId(generateId(), 'evidenceId'),
        projectId: validProjectId,
        mutationGroupId: requireOpaqueId(mutationGroupId, 'mutationGroupId'),
        assetId: projectAssetId(validProjectId, assetId),
        artifactRole: requireLabel(artifactRole, 'artifactRole'),
        retentionReason: requireLabel(retentionReason, 'retentionReason'),
        artifactPath: relativePath(artifactPath, 'artifactPath'),
        sourcePath: optionalRelativePath(sourcePath, 'sourcePath'),
        destinationPath: optionalRelativePath(destinationPath, 'destinationPath'),
        ...exact,
        expectedSize: optionalSize(expectedSize),
        expectedSha256: optionalSha256(expectedSha256),
        lifecycle: requireEnum(lifecycle, PROCESSING_RECOVERY_LIFECYCLES, 'lifecycle'),
        now: timestamp(),
      };
      insertEvidenceStmt.run(params);
      return mapEvidence(findEvidenceStmt.get(params.projectId, params.evidenceId));
    },

    findEvidence(projectId, evidenceId) {
      const key = evidenceKey(projectId, evidenceId);
      return mapEvidence(findEvidenceStmt.get(key.projectId, key.evidenceId));
    },

    /** Every evidence row of the project: rows exist only while unresolved. */
    listUnresolvedEvidenceByProject(projectId) {
      return listEvidenceByProjectStmt.all(requireProjectId(projectId)).map(mapEvidence);
    },

    listEvidenceByRun(projectId, runId) {
      return listEvidenceByRunStmt.all(requireProjectId(projectId), requireOpaqueId(runId, 'runId')).map(mapEvidence);
    },

    listEvidenceByMutationGroup(projectId, groupId) {
      const key = groupKey(projectId, groupId);
      return listEvidenceByGroupStmt.all(key.projectId, key.groupId).map(mapEvidence);
    },

    /**
     * Attach the descriptor-owned exact identity once ownership is established.
     * @returns {boolean} false when absent here or an identity is already recorded
     */
    attachEvidenceIdentity(projectId, evidenceId, identity) {
      return attachIdentityStmt.run({
        ...evidenceKey(projectId, evidenceId), ...exactIdentity(identity), now: timestamp(),
      }).changes > 0;
    },

    updateEvidenceContentProof(projectId, evidenceId, { expectedSize = null, expectedSha256 = null } = {}) {
      return updateContentProofStmt.run({
        ...evidenceKey(projectId, evidenceId),
        expectedSize: optionalSize(expectedSize),
        expectedSha256: optionalSha256(expectedSha256),
        now: timestamp(),
      }).changes > 0;
    },

    /**
     * Finalize or refine why this artifact is retained (e.g. once the failing
     * phase is known). Descriptive recovery context only, never cleanup authority.
     * @returns {boolean} false when the row does not exist in this project
     */
    setEvidenceRetentionReason(projectId, evidenceId, retentionReason) {
      return setRetentionReasonStmt.run({
        ...evidenceKey(projectId, evidenceId),
        retentionReason: requireLabel(retentionReason, 'retentionReason'),
        now: timestamp(),
      }).changes > 0;
    },

    setEvidenceLifecycle(projectId, evidenceId, lifecycle) {
      return setLifecycleStmt.run({
        ...evidenceKey(projectId, evidenceId),
        lifecycle: requireEnum(lifecycle, PROCESSING_RECOVERY_LIFECYCLES, 'lifecycle'),
        now: timestamp(),
      }).changes > 0;
    },

    /** Record what a later targeted check saw; never changes lifecycle. */
    setEvidenceObservation(projectId, evidenceId, observation) {
      return setObservationStmt.run({
        ...evidenceKey(projectId, evidenceId),
        observation: requireEnum(observation, PROCESSING_RECOVERY_OBSERVATIONS, 'observation'),
        now: timestamp(),
      }).changes > 0;
    },

    /**
     * Remove one evidence row after its caller has resolved it (e.g. verified
     * cleanup). The row itself never authorizes any filesystem deletion.
     */
    deleteEvidence(projectId, evidenceId) {
      const key = evidenceKey(projectId, evidenceId);
      return deleteEvidenceStmt.run(key.projectId, key.evidenceId).changes > 0;
    },
  };
}
