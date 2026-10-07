import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { createProcessingRecoveryGateRepository } from '../src/data/processing-recovery-gate-repository.js';
import {
  createProcessingRecoveryEvidenceRecorder,
  RECOVERY_EVIDENCE_PERSISTENCE_FAILED,
} from '../src/services/processing-recovery-evidence-recorder.js';
import { createOwnedFile, removeFileIfExactIdentityMatches } from '../src/services/owned-file.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const RECORDER_SOURCE = fileURLToPath(new URL('../src/services/processing-recovery-evidence-recorder.js', import.meta.url));
const SHA = 'cd'.repeat(32);

// Neutral fixture labels: no operation-specific role or reason is defined in WP2.
const INTENT = Object.freeze({
  artifactRole: 'fixture-artifact',
  retentionReason: 'fixture-pending',
  artifactPath: '.creatorcrate-fixture/0001.bin',
});

function sqliteFailure() {
  return Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR' });
}

describe('processing recovery evidence recorder', () => {
  let tmpDir;
  let db;
  let repo;
  let recorder;
  let assetRepository;
  let projectId;
  let otherProjectId;
  let artifactAbsPath;

  function insertProject(slug) {
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type) VALUES (?, ?, 'tbd', 'images')
    `).run(slug, slug).lastInsertRowid);
  }

  function insertAsset(relativePath, { sizeBytes = 10, modifiedAt = '2026-09-30T00:00:00.000Z' } = {}) {
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, size_bytes, modified_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, relativePath, path.posix.basename(relativePath), sizeBytes, modifiedAt).lastInsertRowid);
  }

  // A repository whose named methods throw (or return the given value) — every other
  // method is the real one on the shared connection.
  function failingRepository(overrides) {
    return { ...repo, ...overrides };
  }

  function recorderWith(overrides) {
    return createProcessingRecoveryEvidenceRecorder({ db, repository: failingRepository(overrides) });
  }

  function startGroup(target = recorder, overrides = {}) {
    return target.startMutationGroup({
      projectId, operation: 'convert', runId: 'job-0001', itemKey: 'item-1', ...overrides,
    });
  }

  function countRows(table) {
    return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
  }

  // The real exclusive create, passing the recorder's hooks through.
  function ownedCreate(absPath = artifactAbsPath, onWrite = () => {}) {
    return ({ onCreated, onOwned }) => createOwnedFile(absPath, (descriptor) => {
      onWrite();
      fs.writeSync(descriptor, 'fixture bytes');
    }, { onCreated, onOwned });
  }

  const discardAt = (absPath = artifactAbsPath) => (identity) => removeFileIfExactIdentityMatches(absPath, identity);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-recorder-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    repo = createProcessingRecoveryEvidenceRepository(db);
    recorder = createProcessingRecoveryEvidenceRecorder({ db, repository: repo });
    assetRepository = createAssetRepository(db);
    projectId = insertProject('project-a');
    otherProjectId = insertProject('project-b');
    artifactAbsPath = path.join(tmpDir, 'artifact.bin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('construction', () => {
    it('requires the application database and defaults to a repository on that connection', () => {
      expect(() => createProcessingRecoveryEvidenceRecorder({})).toThrow(/application database/);
      const defaulted = createProcessingRecoveryEvidenceRecorder({ db });
      const group = startGroup(defaulted);
      expect(repo.findMutationGroup(projectId, group.groupId)).toMatchObject({ checkpoint: null });
    });
  });

  describe('mutation groups', () => {
    it('durably creates a group with no checkpoint before any evidence, keyed by the run ID', () => {
      const group = startGroup();
      expect(group).toMatchObject({ projectId, runId: 'job-0001', operation: 'convert', itemKey: 'item-1' });
      expect(repo.findMutationGroup(projectId, group.groupId))
        .toMatchObject({ runId: 'job-0001', itemKey: 'item-1', checkpoint: null, checkpointAt: null });
      expect(countRows('processing_recovery_evidence')).toBe(0);
    });

    it('supports several items of one run as distinct groups', () => {
      const first = startGroup(recorder, { itemKey: 'item-1' });
      const second = startGroup(recorder, { itemKey: 'item-2' });
      expect(first.groupId).not.toBe(second.groupId);
      expect(repo.listMutationGroupsByRun(projectId, 'job-0001').map((g) => g.itemKey).sort()).toEqual(['item-1', 'item-2']);
    });

    it('fails as an ordinary persistence failure when the group cannot be written', () => {
      const failing = recorderWith({ createMutationGroup: () => { throw sqliteFailure(); } });
      let error;
      try { startGroup(failing); } catch (err) { error = err; }
      expect(error).toMatchObject({ code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'group' });
      expect(error.message).not.toMatch(/SQLITE/);
      expect(error.cause.code).toBe('SQLITE_IOERR');
    });

    it('refuses to start a group inside a transaction, where it would not yet be durable', () => {
      expect(() => recorder.runInTransaction(() => startGroup())).toThrow(/cannot run inside a transaction/);
      expect(countRows('processing_recovery_mutation_groups')).toBe(0);
    });
  });

  describe('intent → create → identity ordering', () => {
    it('commits the intent before create runs and the exact identity before the file is written', async () => {
      const group = startGroup();
      const seen = {};
      const result = await group.createArtifact({
        intent: INTENT,
        create: ownedCreate(artifactAbsPath, () => {
          seen.atWrite = repo.listEvidenceByMutationGroup(projectId, group.groupId);
        }),
        discardOwned: discardAt(),
      });
      expect(seen.atWrite).toHaveLength(1);
      expect(seen.atWrite[0]).toMatchObject({ lifecycle: 'intent', evidenceId: result.evidenceId });
      expect(seen.atWrite[0].identity).toEqual({
        dev: result.exactIdentity.dev.toString(), ino: result.exactIdentity.ino.toString(), birthtimeNs: null,
      });
      expect(typeof result.exactIdentity.dev).toBe('bigint');
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBeNull();
    });

    it('has the intent row durable (identity null) when create begins', async () => {
      const group = startGroup();
      let atCreate;
      await group.createArtifact({
        intent: INTENT,
        create: (hooks) => {
          atCreate = repo.listEvidenceByMutationGroup(projectId, group.groupId);
          return ownedCreate()(hooks);
        },
        discardOwned: discardAt(),
      });
      expect(atCreate).toHaveLength(1);
      expect(atCreate[0]).toMatchObject({ lifecycle: 'intent', identity: null, mutationGroupId: group.groupId });
    });

    it('never starts create when the intent cannot be persisted (no gate, no file)', async () => {
      const group = startGroup(recorderWith({ createEvidence: () => { throw sqliteFailure(); } }));
      const create = vi.fn(ownedCreate());
      const discardOwned = vi.fn(discardAt());
      const error = await group.createArtifact({ intent: INTENT, create, discardOwned }).catch((err) => err);
      expect(error).toMatchObject({ code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'intent' });
      expect(error.code).not.toBe('RECOVERY_REQUIRED');
      expect(create).not.toHaveBeenCalled();
      expect(discardOwned).not.toHaveBeenCalled();
      expect(fs.existsSync(artifactAbsPath)).toBe(false);
    });

    it('stops before writing and removes the file under its in-memory identity when identity persistence fails', async () => {
      const group = startGroup(recorderWith({ attachEvidenceIdentity: () => { throw sqliteFailure(); } }));
      const onWrite = vi.fn();
      const later = vi.fn();
      const discarded = [];
      const error = await group.createArtifact({
        intent: INTENT,
        create: ownedCreate(artifactAbsPath, onWrite),
        discardOwned: (identity) => {
          discarded.push(identity);
          return removeFileIfExactIdentityMatches(artifactAbsPath, identity);
        },
      }).then(later, (err) => err);

      expect(later).not.toHaveBeenCalled();
      expect(onWrite).not.toHaveBeenCalled();
      expect(error).toMatchObject({
        code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'identity', ownedArtifactRemoved: true,
      });
      // Cleanup authority was the exact descriptor identity, not a database row.
      expect(discarded).toHaveLength(1);
      expect(typeof discarded[0].dev).toBe('bigint');
      expect(typeof discarded[0].ino).toBe('bigint');
      expect(fs.existsSync(artifactAbsPath)).toBe(false);
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toEqual([]);
    });

    it('treats an identity write that changes no row as a failure', async () => {
      const group = startGroup(recorderWith({ attachEvidenceIdentity: () => false }));
      const error = await group.createArtifact({
        intent: INTENT, create: ownedCreate(), discardOwned: discardAt(),
      }).catch((err) => err);
      expect(error).toMatchObject({ code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'identity' });
      expect(fs.existsSync(artifactAbsPath)).toBe(false);
    });

    it('fails closed with RECOVERY_REQUIRED when the owned file cannot be proven removed', async () => {
      const group = startGroup(recorderWith({ attachEvidenceIdentity: () => { throw sqliteFailure(); } }));
      const error = await group.createArtifact({
        intent: INTENT, create: ownedCreate(), discardOwned: () => false,
      }).catch((err) => err);
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', evidenceStage: 'identity' });
      expect(error.cause.code).toBe('SQLITE_IOERR');
      expect(fs.existsSync(artifactAbsPath)).toBe(true);
      // The intent row stays unresolved: nothing was invented or removed.
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { lifecycle: 'intent', identity: null },
      ]);
    });

    it('fails closed when the ownership-authorized removal itself throws', async () => {
      const group = startGroup(recorderWith({ attachEvidenceIdentity: () => { throw sqliteFailure(); } }));
      const error = await group.createArtifact({
        intent: INTENT, create: ownedCreate(), discardOwned: () => { throw new Error('EPERM'); },
      }).catch((err) => err);
      expect(error.code).toBe('RECOVERY_REQUIRED');
    });

    it('surfaces RECOVERY_REQUIRED through the existing project gate model', async () => {
      // Mirrors the processing job hook: RECOVERY_REQUIRED retains the held gate row.
      const gate = createProcessingRecoveryGateRepository(db);
      const group = startGroup(recorderWith({ attachEvidenceIdentity: () => { throw sqliteFailure(); } }));
      const hold = gate.holdForProcessing(projectId);
      try {
        await group.createArtifact({ intent: INTENT, create: ownedCreate(), discardOwned: () => false });
        hold.release();
      } catch (error) {
        if (error?.code === 'RECOVERY_REQUIRED') hold.retain();
        else hold.release();
      }
      expect(gate.isRecoveryRequired(projectId)).toBe(true);
    });

    it('leaves a created-but-unclaimed path alone and the intent unresolved', async () => {
      const group = startGroup();
      fs.writeFileSync(artifactAbsPath, 'not ours to adopt');
      const discardOwned = vi.fn();
      const unclaimed = new Error('The created file exposed no known exact identity.');
      const error = await group.createArtifact({
        intent: INTENT,
        create: ({ onCreated }) => { onCreated(); throw unclaimed; },
        discardOwned,
      }).catch((err) => err);
      expect(error).toBe(unclaimed);
      expect(discardOwned).not.toHaveBeenCalled();
      expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('not ours to adopt');
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { lifecycle: 'intent', identity: null, observation: 'ownership-unknown' },
      ]);
    });

    it('rethrows an ordinary create failure after identity was persisted, without removing anything', async () => {
      const group = startGroup();
      const writeFailure = new Error('ENOSPC');
      const discardOwned = vi.fn();
      const error = await group.createArtifact({
        intent: INTENT,
        create: ownedCreate(artifactAbsPath, () => { throw writeFailure; }),
        discardOwned,
      }).catch((err) => err);
      expect(error).toBe(writeFailure);
      expect(discardOwned).not.toHaveBeenCalled();
      const [row] = repo.listEvidenceByMutationGroup(projectId, group.groupId);
      expect(row.identity).not.toBeNull();
    });

    it('refuses a create that completed without establishing exact ownership', async () => {
      const group = startGroup();
      await expect(group.createArtifact({
        intent: INTENT, create: async () => 'no hooks used', discardOwned: vi.fn(),
      })).rejects.toThrow(/without establishing exact ownership/);
    });
  });

  describe('mutation checkpoint', () => {
    it('commits the checkpoint before the mutation callback runs', () => {
      const group = startGroup();
      let atMutation;
      const result = group.beginMutation('replace', () => {
        atMutation = repo.findMutationGroup(projectId, group.groupId);
        return 'mutated';
      });
      expect(result).toBe('mutated');
      expect(atMutation.checkpoint).toBe('replace');
      expect(atMutation.checkpointAt).not.toBeNull();
    });

    it('never runs the destructive callback when the checkpoint write throws', () => {
      const group = startGroup(recorderWith({ markMutationCheckpoint: () => { throw sqliteFailure(); } }));
      const mutate = vi.fn();
      expect(() => group.beginMutation('unlink', mutate)).toThrow(expect.objectContaining({
        code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'checkpoint',
      }));
      expect(mutate).not.toHaveBeenCalled();
    });

    it('never runs the destructive callback when the checkpoint write persists nothing', () => {
      const group = startGroup();
      repo.deleteMutationGroup(projectId, group.groupId);
      const mutate = vi.fn();
      expect(() => group.beginMutation('unlink', mutate)).toThrow(expect.objectContaining({
        evidenceStage: 'checkpoint',
      }));
      expect(mutate).not.toHaveBeenCalled();
    });

    it('refuses a checkpoint inside a transaction, where it would not yet be durable', () => {
      const group = startGroup();
      const mutate = vi.fn();
      expect(() => recorder.runInTransaction(() => group.beginMutation('replace', mutate)))
        .toThrow(/cannot run inside a transaction/);
      expect(mutate).not.toHaveBeenCalled();
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBeNull();
    });

    it('marks a create checkpoint after the intent and before create; failure stops create', async () => {
      const group = startGroup();
      let atCreate;
      await group.createArtifact({
        intent: INTENT,
        checkpoint: 'public-create',
        create: (hooks) => {
          atCreate = {
            group: repo.findMutationGroup(projectId, group.groupId),
            rows: repo.listEvidenceByMutationGroup(projectId, group.groupId),
          };
          return ownedCreate()(hooks);
        },
        discardOwned: discardAt(),
      });
      expect(atCreate.group.checkpoint).toBe('public-create');
      expect(atCreate.rows).toHaveLength(1);

      const failing = startGroup(recorderWith({ markMutationCheckpoint: () => { throw sqliteFailure(); } }));
      const create = vi.fn();
      const error = await failing.createArtifact({
        intent: INTENT, checkpoint: 'public-create', create, discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(error.evidenceStage).toBe('checkpoint');
      expect(create).not.toHaveBeenCalled();
    });

    it('is cleared only by an explicit resolveMutation', () => {
      const group = startGroup();
      const artifact = repo.createEvidence({ ...INTENT, projectId, mutationGroupId: group.groupId });
      group.beginMutation('replace', () => {});

      group.recordContentProof(artifact.evidenceId, { expectedSize: 13, expectedSha256: SHA });
      group.markRecoveryCritical(artifact.evidenceId, { retentionReason: 'fixture-unresolved' });
      repo.setEvidenceObservation(projectId, artifact.evidenceId, 'present');
      group.markDispensable(artifact.evidenceId);
      recorder.runInTransaction(() => group.markRecoveryCritical(artifact.evidenceId));
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe('replace');

      expect(group.resolveMutation()).toBe(true);
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBeNull();
      expect(group.resolveMutation()).toBe(false);
    });

    it('reports a failed explicit resolution', () => {
      const group = startGroup(recorderWith({ clearMutationCheckpoint: () => { throw sqliteFailure(); } }));
      expect(() => group.resolveMutation()).toThrow(expect.objectContaining({ evidenceStage: 'resolution' }));
    });
  });

  describe('finalization', () => {
    let group;
    let assetId;
    let artifact;

    beforeEach(async () => {
      group = startGroup();
      assetId = insertAsset('Final/a.png');
      const created = await group.createArtifact({
        intent: { ...INTENT, assetId }, create: ownedCreate(), discardOwned: discardAt(),
      });
      artifact = repo.findEvidence(projectId, created.evidenceId);
    });

    it('marks one row recovery-critical with its retention reason, keeping identity, group and asset', () => {
      group.markRecoveryCritical(artifact.evidenceId, { retentionReason: 'fixture-unresolved' });
      expect(repo.findEvidence(projectId, artifact.evidenceId)).toMatchObject({
        evidenceId: artifact.evidenceId,
        mutationGroupId: group.groupId,
        assetId,
        identity: artifact.identity,
        lifecycle: 'recovery-critical',
        retentionReason: 'fixture-unresolved',
      });
    });

    it('marks one row dispensable without deleting the row or the file', () => {
      group.markDispensable(artifact.evidenceId, { retentionReason: 'fixture-residue' });
      expect(repo.findEvidence(projectId, artifact.evidenceId)).toMatchObject({
        lifecycle: 'dispensable', retentionReason: 'fixture-residue', identity: artifact.identity,
      });
      expect(fs.existsSync(artifactAbsPath)).toBe(true);
    });

    it('never finalizes another group\'s or another project\'s evidence', () => {
      const sibling = startGroup(recorder, { itemKey: 'item-2' });
      const siblingRow = repo.createEvidence({ ...INTENT, projectId, mutationGroupId: sibling.groupId });
      expect(() => group.markDispensable(siblingRow.evidenceId))
        .toThrow(expect.objectContaining({ evidenceStage: 'finalization' }));
      expect(repo.findEvidence(projectId, siblingRow.evidenceId).lifecycle).toBe('intent');

      const foreignGroup = repo.createMutationGroup({ projectId: otherProjectId, operation: 'convert', runId: 'job-0001' });
      const foreignRow = repo.createEvidence({ ...INTENT, projectId: otherProjectId, mutationGroupId: foreignGroup.groupId });
      expect(() => group.markRecoveryCritical(foreignRow.evidenceId)).toThrow();
      expect(repo.findEvidence(otherProjectId, foreignRow.evidenceId).lifecycle).toBe('intent');

      // Resolving one group leaves every other group's checkpoint alone.
      group.beginMutation('replace', () => {});
      sibling.beginMutation('unlink', () => {});
      group.resolveMutation();
      expect(repo.findMutationGroup(projectId, sibling.groupId).checkpoint).toBe('unlink');
    });

    it('commits asset/index writes and evidence finalization in one transaction', () => {
      recorder.runInTransaction(() => {
        assetRepository.applyAssetPromptEdits(projectId, [{
          assetId, expectedRelativePath: 'Final/a.png', expectedSizeBytes: 10,
          expectedModifiedAt: '2026-09-30T00:00:00.000Z', sizeBytes: 99, modifiedAt: '2026-09-30T01:00:00.000Z',
        }]);
        group.markDispensable(artifact.evidenceId, { retentionReason: 'fixture-residue' });
      });
      expect(assetRepository.findById(assetId).size_bytes).toBe(99);
      expect(repo.findEvidence(projectId, artifact.evidenceId))
        .toMatchObject({ lifecycle: 'dispensable', retentionReason: 'fixture-residue' });
    });

    it('rolls back the asset/index write and the evidence write when finalization fails', () => {
      // The retention write succeeds inside the transaction; the lifecycle write then fails.
      const failing = recorderWith({ setEvidenceLifecycle: () => { throw sqliteFailure(); } });
      const failingGroup = startGroup(failing, { itemKey: 'item-2' });
      const row = repo.createEvidence({ ...INTENT, projectId, mutationGroupId: failingGroup.groupId });

      expect(() => failing.runInTransaction(() => {
        assetRepository.applyAssetPromptEdits(projectId, [{
          assetId, expectedRelativePath: 'Final/a.png', expectedSizeBytes: 10,
          expectedModifiedAt: '2026-09-30T00:00:00.000Z', sizeBytes: 99, modifiedAt: '2026-09-30T01:00:00.000Z',
        }]);
        failingGroup.markDispensable(row.evidenceId, { retentionReason: 'fixture-residue' });
      })).toThrow(expect.objectContaining({ evidenceStage: 'finalization' }));

      expect(assetRepository.findById(assetId)).toMatchObject({ size_bytes: 10, modified_at: '2026-09-30T00:00:00.000Z' });
      expect(repo.findEvidence(projectId, row.evidenceId))
        .toMatchObject({ lifecycle: 'intent', retentionReason: INTENT.retentionReason });
      expect(db.inTransaction).toBe(false);
    });

    it('rejects an asynchronous transaction body and commits nothing', () => {
      expect(() => recorder.runInTransaction(async () => {
        group.markDispensable(artifact.evidenceId);
      })).toThrow(/synchronous/);
      expect(repo.findEvidence(projectId, artifact.evidenceId).lifecycle).toBe('intent');
    });
  });

  describe('created-but-unclaimed classification', () => {
    // A path this create made exclusively, then reported via onCreated, never claimed.
    function unclaimedCreate(failure, { throwAfterCreate = true } = {}) {
      return ({ onCreated }) => {
        fs.writeFileSync(artifactAbsPath, 'unclaimed', { flag: 'wx' });
        onCreated();
        if (throwAfterCreate) throw failure;
        return 'returned without onOwned';
      };
    }

    // The processing route's job hook, verbatim: RECOVERY_REQUIRED retains the held gate.
    async function runUnderJobHook(work) {
      const hold = createProcessingRecoveryGateRepository(db).holdForProcessing(projectId);
      try {
        await work();
      } catch (error) {
        if (error?.code === 'RECOVERY_REQUIRED') hold.retain();
        else hold.release();
        return error;
      }
      hold.release();
      return undefined;
    }

    it('escalates a checkpointed create that fired onCreated but never onOwned', async () => {
      const group = startGroup();
      const unclaimed = new Error('The created file exposed no known exact identity.');
      const discardOwned = vi.fn();
      const error = await group.createArtifact({
        intent: INTENT, checkpoint: 'public-create', create: unclaimedCreate(unclaimed), discardOwned,
      }).catch((err) => err);

      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', evidenceStage: 'identity', ownedArtifactRemoved: false });
      expect(error.cause).toBe(unclaimed);
      expect(error.observationFailure).toBeUndefined();
      // Neither adopted nor removed, no identity invented, checkpoint retained.
      expect(discardOwned).not.toHaveBeenCalled();
      expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('unclaimed');
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { lifecycle: 'intent', identity: null, observation: 'ownership-unknown' },
      ]);
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe('public-create');
    });

    it('escalates a checkpointed create that returned after onCreated without ownership', async () => {
      const group = startGroup();
      const error = await group.createArtifact({
        intent: INTENT,
        checkpoint: 'public-create',
        create: unclaimedCreate(null, { throwAfterCreate: false }),
        discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', evidenceStage: 'identity' });
      expect(error.cause.message).toMatch(/without establishing exact ownership/);
      expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('unclaimed');
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { identity: null, observation: 'ownership-unknown' },
      ]);
    });

    it('stays RECOVERY_REQUIRED when the ownership-unknown observation cannot be written', async () => {
      const group = startGroup(recorderWith({ setEvidenceObservation: () => { throw sqliteFailure(); } }));
      const unclaimed = new Error('The created file exposed no known exact identity.');
      const error = await group.createArtifact({
        intent: INTENT, checkpoint: 'public-create', create: unclaimedCreate(unclaimed), discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(error.code).toBe('RECOVERY_REQUIRED');
      expect(error.cause).toBe(unclaimed);
      expect(error.observationFailure.code).toBe('SQLITE_IOERR');
      expect(error.message).not.toMatch(/SQLITE/);
      expect(fs.existsSync(artifactAbsPath)).toBe(true);
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { lifecycle: 'intent', identity: null, observation: 'unchecked' },
      ]);
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe('public-create');
    });

    it('escalates when the group was checkpointed by an earlier beginMutation', async () => {
      const group = startGroup();
      group.beginMutation('replace', () => {});
      const error = await group.createArtifact({
        intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(error.code).toBe('RECOVERY_REQUIRED');
    });

    it('keeps a private (non-checkpointed) unclaimed create an ordinary failure, path untouched', async () => {
      const group = startGroup();
      const thrown = await group.createArtifact({
        intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(thrown.message).toBe('unclaimed');
      expect(thrown.code).toBeUndefined();
      fs.rmSync(artifactAbsPath);

      const returned = await group.createArtifact({
        intent: INTENT, create: unclaimedCreate(null, { throwAfterCreate: false }), discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(returned.message).toMatch(/without establishing exact ownership/);
      expect(returned.code).toBeUndefined();
      expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('unclaimed');
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { identity: null, observation: 'ownership-unknown' },
        { identity: null, observation: 'ownership-unknown' },
      ]);
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBeNull();
    });

    it('is a private failure again once the group checkpoint was explicitly resolved', async () => {
      const group = startGroup();
      group.beginMutation('replace', () => {});
      group.resolveMutation();
      const error = await group.createArtifact({
        intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(error.code).toBeUndefined();
    });

    it('retains the project gate through the job hook for a public unclaimed create, releases it for a private one', async () => {
      const gate = createProcessingRecoveryGateRepository(db);
      const privateError = await runUnderJobHook(() => startGroup().createArtifact({
        intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
      }));
      expect(privateError.message).toBe('unclaimed');
      expect(gate.isRecoveryRequired(projectId)).toBe(false);
      fs.rmSync(artifactAbsPath);

      const publicError = await runUnderJobHook(() => startGroup().createArtifact({
        intent: INTENT, checkpoint: 'public-create', create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
      }));
      expect(publicError.code).toBe('RECOVERY_REQUIRED');
      expect(gate.isRecoveryRequired(projectId)).toBe(true);
      expect(fs.existsSync(artifactAbsPath)).toBe(true);
    });

    describe('mutation resolution is durable before the handle forgets the checkpoint', () => {
      const checkpointOf = (group) => repo.findMutationGroup(projectId, group.groupId).checkpoint;

      // A durable checkpoint from an earlier beginMutation; the later create passes no
      // checkpoint of its own, so only the handle's retained state can classify it.
      function checkpointedGroup(target = recorder) {
        const group = startGroup(target);
        group.beginMutation('replace', () => {});
        expect(checkpointOf(group)).toBe('replace');
        return group;
      }

      function resolveInsideRolledBackTransaction(group) {
        let refused;
        db.exec('BEGIN');
        try {
          try {
            group.resolveMutation();
          } catch (err) {
            refused = err;
          }
          expect(checkpointOf(group)).toBe('replace');
        } finally {
          db.exec('ROLLBACK');
        }
        return refused;
      }

      function expectResolutionRefused(error) {
        expect(error).toMatchObject({
          code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'resolution', ownedArtifactRemoved: false,
        });
      }

      it('refuses resolution inside an open transaction; after rollback a public unclaimed create stays RECOVERY_REQUIRED', async () => {
        const gate = createProcessingRecoveryGateRepository(db);
        const group = checkpointedGroup();

        const refused = resolveInsideRolledBackTransaction(group);
        expect(db.inTransaction).toBe(false);
        expect(checkpointOf(group)).toBe('replace');
        expectResolutionRefused(refused);
        expect(refused.cause.message).toMatch(/inside a transaction/);

        const discardOwned = vi.fn();
        const error = await runUnderJobHook(() => group.createArtifact({
          intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned,
        }));
        expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', evidenceStage: 'identity' });
        expect(gate.isRecoveryRequired(projectId)).toBe(true);
        expect(discardOwned).not.toHaveBeenCalled();
        expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('unclaimed');
        expect(checkpointOf(group)).toBe('replace');
      });

      it('stays RECOVERY_REQUIRED after a refused resolution even when ownership-unknown cannot be recorded', async () => {
        const gate = createProcessingRecoveryGateRepository(db);
        const group = checkpointedGroup(recorderWith({ setEvidenceObservation: () => { throw sqliteFailure(); } }));
        expectResolutionRefused(resolveInsideRolledBackTransaction(group));

        const error = await runUnderJobHook(() => group.createArtifact({
          intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
        }));
        expect(error.code).toBe('RECOVERY_REQUIRED');
        expect(error.observationFailure.code).toBe('SQLITE_IOERR');
        expect(gate.isRecoveryRequired(projectId)).toBe(true);
        expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('unclaimed');
        expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
          { lifecycle: 'intent', identity: null, observation: 'unchecked' },
        ]);
        expect(checkpointOf(group)).toBe('replace');
      });

      it('resolves in autocommit: the checkpoint is durably cleared and a private unclaimed create is ordinary again', async () => {
        const gate = createProcessingRecoveryGateRepository(db);
        const group = checkpointedGroup();
        expect(group.resolveMutation()).toBe(true);
        expect(checkpointOf(group)).toBeNull();
        expect(group.resolveMutation()).toBe(false);
        expect(checkpointOf(group)).toBeNull();

        const error = await runUnderJobHook(() => group.createArtifact({
          intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
        }));
        expect(error.message).toBe('unclaimed');
        expect(error.code).toBeUndefined();
        expect(gate.isRecoveryRequired(projectId)).toBe(false);
        expect(fs.readFileSync(artifactAbsPath, 'utf8')).toBe('unclaimed');
      });

      it('keeps the checkpoint, durably and in memory, when the checkpoint clear fails or does not persist', async () => {
        const failures = [
          { overrides: { clearMutationCheckpoint: () => { throw sqliteFailure(); } }, durable: 'replace' },
          // Reports success without clearing: the read-back must refuse to trust it.
          { overrides: { clearMutationCheckpoint: () => true }, durable: 'replace' },
          // The clear committed but could not be observed: the handle still stays conservative.
          { overrides: { findMutationGroup: () => { throw sqliteFailure(); } }, durable: null },
        ];
        for (const [index, { overrides, durable }] of failures.entries()) {
          const group = checkpointedGroup(recorderWith(overrides));
          const error = (() => {
            try {
              group.resolveMutation();
            } catch (err) {
              return err;
            }
            return undefined;
          })();
          expectResolutionRefused(error);
          expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe(durable);

          const absPath = path.join(tmpDir, `unclaimed-${index}.bin`);
          const created = await group.createArtifact({
            intent: INTENT,
            create: ({ onCreated }) => {
              fs.writeFileSync(absPath, 'unclaimed', { flag: 'wx' });
              onCreated();
              throw new Error('unclaimed');
            },
            discardOwned: vi.fn(),
          }).catch((err) => err);
          expect(created.code).toBe('RECOVERY_REQUIRED');
          expect(fs.existsSync(absPath)).toBe(true);
        }
      });

      it('rejects resolution inside runInTransaction, rolling back the other writes and keeping the checkpoint', async () => {
        const gate = createProcessingRecoveryGateRepository(db);
        const group = checkpointedGroup();
        const row = repo.createEvidence({ ...INTENT, projectId, mutationGroupId: group.groupId });

        let refused;
        try {
          recorder.runInTransaction(() => {
            group.markDispensable(row.evidenceId, { retentionReason: 'fixture-residue' });
            group.resolveMutation();
          });
        } catch (err) {
          refused = err;
        }
        expectResolutionRefused(refused);
        expect(refused.cause.message).toMatch(/inside a transaction/);
        expect(db.inTransaction).toBe(false);
        expect(repo.findEvidence(projectId, row.evidenceId))
          .toMatchObject({ lifecycle: 'intent', retentionReason: INTENT.retentionReason });
        expect(checkpointOf(group)).toBe('replace');

        const error = await runUnderJobHook(() => group.createArtifact({
          intent: INTENT, create: unclaimedCreate(new Error('unclaimed')), discardOwned: vi.fn(),
        }));
        expect(error.code).toBe('RECOVERY_REQUIRED');
        expect(gate.isRecoveryRequired(projectId)).toBe(true);
        expect(fs.existsSync(artifactAbsPath)).toBe(true);
      });
    });
  });

  describe('identity attachment requires autocommit', () => {
    // The creating call runs while the caller holds an open transaction, which it rolls
    // back after createOwnedFile's synchronous prefix (open → onCreated → onOwned).
    function createInsideTransaction(onWrite) {
      return (hooks) => {
        db.exec('BEGIN');
        let pending;
        try {
          pending = createOwnedFile(artifactAbsPath, (descriptor) => {
            onWrite();
            fs.writeSync(descriptor, 'fixture bytes');
          }, hooks);
        } finally {
          db.exec('ROLLBACK');
        }
        return pending;
      };
    }

    it('refuses identity inside a transaction before any byte is written and removes the file by exact identity', async () => {
      const group = startGroup();
      const onWrite = vi.fn();
      const discarded = [];
      const error = await group.createArtifact({
        intent: INTENT,
        create: createInsideTransaction(onWrite),
        discardOwned: (identity) => {
          discarded.push({ identity, size: fs.statSync(artifactAbsPath).size });
          return removeFileIfExactIdentityMatches(artifactAbsPath, identity);
        },
      }).catch((err) => err);

      expect(error).toMatchObject({
        code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'identity', ownedArtifactRemoved: true,
      });
      expect(error.cause.message).toMatch(/inside a transaction/);
      expect(onWrite).not.toHaveBeenCalled();
      expect(discarded).toHaveLength(1);
      expect(discarded[0].size).toBe(0);
      expect(typeof discarded[0].identity.dev).toBe('bigint');
      expect(fs.existsSync(artifactAbsPath)).toBe(false);
      expect(db.inTransaction).toBe(false);
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toEqual([]);
    });

    it('refuses identity when creation is invoked from inside db.transaction', async () => {
      const group = startGroup();
      const onWrite = vi.fn();
      const error = await group.createArtifact({
        intent: INTENT,
        create: (hooks) => {
          let pending;
          db.transaction(() => {
            pending = createOwnedFile(artifactAbsPath, (descriptor) => {
              onWrite();
              fs.writeSync(descriptor, 'fixture bytes');
            }, hooks);
          })();
          return pending;
        },
        discardOwned: discardAt(),
      }).catch((err) => err);
      expect(error).toMatchObject({ code: RECOVERY_EVIDENCE_PERSISTENCE_FAILED, evidenceStage: 'identity' });
      expect(onWrite).not.toHaveBeenCalled();
      expect(fs.existsSync(artifactAbsPath)).toBe(false);
    });

    it('fails closed with RECOVERY_REQUIRED when the refused file cannot be proven removed', async () => {
      const group = startGroup();
      const onWrite = vi.fn();
      const error = await group.createArtifact({
        intent: INTENT, create: createInsideTransaction(onWrite), discardOwned: () => false,
      }).catch((err) => err);
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', evidenceStage: 'identity' });
      expect(error.cause.message).toMatch(/inside a transaction/);
      expect(onWrite).not.toHaveBeenCalled();
      expect(fs.statSync(artifactAbsPath).size).toBe(0);
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([
        { lifecycle: 'intent', identity: null },
      ]);
    });
  });

  describe('callback Promise contracts', () => {
    it('does not accept a create that resolves before its hooks ran; late hooks are refused', async () => {
      const group = startGroup();
      const onWrite = vi.fn();
      let late;
      const error = await group.createArtifact({
        intent: INTENT,
        create: (hooks) => {
          late = new Promise((resolve) => setImmediate(resolve)).then(() => ownedCreate(artifactAbsPath, onWrite)(hooks));
          return Promise.resolve('resolved early');
        },
        discardOwned: vi.fn(),
      }).catch((err) => err);
      expect(error.message).toMatch(/without establishing exact ownership/);

      await expect(late).rejects.toThrow(/after createArtifact settled/);
      expect(onWrite).not.toHaveBeenCalled();
      expect(repo.listEvidenceByMutationGroup(projectId, group.groupId)).toMatchObject([{ identity: null }]);
    });

    it('never treats a Promise from discardOwned as proven removal', async () => {
      const group = startGroup(recorderWith({ attachEvidenceIdentity: () => { throw sqliteFailure(); } }));
      const error = await group.createArtifact({
        intent: INTENT, create: ownedCreate(), discardOwned: async () => true,
      }).catch((err) => err);
      expect(error.code).toBe('RECOVERY_REQUIRED');
      expect(fs.existsSync(artifactAbsPath)).toBe(true);
    });

    it('never treats an asynchronous mutate as a completed (resolved) mutation', async () => {
      const group = startGroup();
      await expect(group.beginMutation('replace', async () => 'done')).resolves.toBe('done');
      await expect(group.beginMutation('unlink', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe('unlink');
    });
  });

  describe('runInTransaction synchronous-body contract', () => {
    let group;
    let row;

    beforeEach(() => {
      group = startGroup();
      row = repo.createEvidence({ ...INTENT, projectId, mutationGroupId: group.groupId });
    });

    const drain = () => new Promise((resolve) => setImmediate(resolve));

    it('refuses a declared async body before invoking it; no write happens before or after its await', async () => {
      let invoked = false;
      expect(() => recorder.runInTransaction(async () => {
        invoked = true;
        group.markRecoveryCritical(row.evidenceId, { retentionReason: 'fixture-pre-await' });
        await Promise.resolve();
        group.markDispensable(row.evidenceId, { retentionReason: 'fixture-post-await' });
      })).toThrow(/requires a synchronous function/);
      await drain();
      await drain();
      expect(invoked).toBe(false);
      expect(repo.findEvidence(projectId, row.evidenceId))
        .toMatchObject({ lifecycle: 'intent', retentionReason: INTENT.retentionReason });
      expect(db.inTransaction).toBe(false);
    });

    it('rolls back the synchronous writes of a body that returns a Promise or thenable', () => {
      for (const returned of [Promise.resolve(), { then() {} }]) {
        expect(() => recorder.runInTransaction(() => {
          group.markDispensable(row.evidenceId, { retentionReason: 'fixture-residue' });
          return returned;
        })).toThrow(/requires a synchronous function/);
        expect(repo.findEvidence(projectId, row.evidenceId))
          .toMatchObject({ lifecycle: 'intent', retentionReason: INTENT.retentionReason });
        expect(db.inTransaction).toBe(false);
      }
    });

    it('commits a synchronous body atomically and returns its value', () => {
      expect(recorder.runInTransaction(() => {
        group.markDispensable(row.evidenceId, { retentionReason: 'fixture-residue' });
        return 'committed';
      })).toBe('committed');
      expect(repo.findEvidence(projectId, row.evidenceId))
        .toMatchObject({ lifecycle: 'dispensable', retentionReason: 'fixture-residue' });
    });
  });

  describe('crash states representable after each durable step', () => {
    it('distinguishes states A through E by durable rows alone', async () => {
      const group = startGroup();
      let stateA;
      const { evidenceId } = await group.createArtifact({
        intent: INTENT,
        create: (hooks) => {
          stateA = {
            group: repo.findMutationGroup(projectId, group.groupId),
            row: repo.listEvidenceByMutationGroup(projectId, group.groupId)[0],
          };
          return ownedCreate()(hooks);
        },
        discardOwned: discardAt(),
      });
      // A: intent persisted, no identity, no checkpoint — no mutation proven begun.
      expect(stateA.group.checkpoint).toBeNull();
      expect(stateA.row).toMatchObject({ lifecycle: 'intent', identity: null });

      // B: identity known, no checkpoint — artifact owned, public mutation not begun.
      expect(repo.findEvidence(projectId, evidenceId).identity).not.toBeNull();
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBeNull();

      // C: checkpoint non-null — mutation may have begun.
      group.beginMutation('replace', () => {});
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe('replace');

      // D: checkpoint non-null and evidence recovery-critical — explicit unresolved state.
      group.markRecoveryCritical(evidenceId, { retentionReason: 'fixture-unresolved' });
      expect(repo.findEvidence(projectId, evidenceId).lifecycle).toBe('recovery-critical');
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBe('replace');

      // E: dispensable and checkpoint explicitly cleared — safe residue awaiting cleanup.
      group.markDispensable(evidenceId);
      group.resolveMutation();
      expect(repo.findEvidence(projectId, evidenceId).lifecycle).toBe('dispensable');
      expect(repo.findMutationGroup(projectId, group.groupId).checkpoint).toBeNull();
      expect(fs.existsSync(artifactAbsPath)).toBe(true);
    });
  });

  describe('database-only state methods', () => {
    it('performs no filesystem access outside the caller callbacks', () => {
      expect(fs.readFileSync(RECORDER_SOURCE, 'utf8')).not.toMatch(/from 'node:fs'|require\(/);
      const touched = [];
      for (const name of ['lstatSync', 'statSync', 'readFileSync', 'readdirSync', 'existsSync', 'openSync', 'unlinkSync']) {
        vi.spyOn(fs, name).mockImplementation((...args) => {
          touched.push(name);
          throw new Error(`unexpected ${name}(${args[0]})`);
        });
      }
      const group = startGroup();
      const row = repo.createEvidence({ ...INTENT, projectId, mutationGroupId: group.groupId });
      group.beginMutation('replace', () => {});
      group.recordContentProof(row.evidenceId, { expectedSize: 1 });
      recorder.runInTransaction(() => group.markRecoveryCritical(row.evidenceId, { retentionReason: 'fixture-unresolved' }));
      group.markDispensable(row.evidenceId);
      group.resolveMutation();
      vi.restoreAllMocks();
      expect(touched).toEqual([]);
    });
  });
});
