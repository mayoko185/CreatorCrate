import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  createProcessingRecoveryEvidenceRepository,
  InvalidProcessingRecoveryEvidenceError,
  PROCESSING_RECOVERY_OPERATIONS,
} from '../src/data/processing-recovery-evidence-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const SHA = 'ab'.repeat(32);
// Beyond Number.MAX_SAFE_INTEGER (2^53 - 1): a Number round-trip would corrupt these.
const BIG_DEV = '18446744073709551557';
const BIG_INO = '9007199254740993';
const BIG_BIRTH = '1727654400123456789';

describe('processing recovery evidence repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let repo;
  let projectA;
  let projectB;
  let clock;
  let ids;

  function open() {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    repo = createProcessingRecoveryEvidenceRepository(db, {
      now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, clock++)),
      generateId: () => `id-${String(ids++).padStart(4, '0')}`,
    });
  }

  function insertProject(slug) {
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type) VALUES (?, ?, 'tbd', 'images')
    `).run(slug, slug).lastInsertRowid);
  }

  function insertAsset(projectId, relativePath) {
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename) VALUES (?, ?, ?)
    `).run(projectId, relativePath, path.posix.basename(relativePath)).lastInsertRowid);
  }

  function group(projectId, overrides = {}) {
    return repo.createMutationGroup({ projectId, operation: 'watermark', runId: 'run-1', ...overrides });
  }

  function evidence(projectId, mutationGroupId, overrides = {}) {
    return repo.createEvidence({
      projectId,
      mutationGroupId,
      artifactRole: 'staged-output',
      retentionReason: 'rollback-unresolved',
      artifactPath: '.creatorcrate-watermark-staging/0011aabb.out.png',
      ...overrides,
    });
  }

  function countRows(table) {
    return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-repo-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    clock = 0;
    ids = 1;
    open();
    projectA = insertProject('project-a');
    projectB = insertProject('project-b');
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates an intent row with no exact identity yet', () => {
    const g = group(projectA, { itemKey: 'asset:12' });
    expect(g).toEqual({
      groupId: 'id-0001', projectId: projectA, operation: 'watermark', runId: 'run-1', itemKey: 'asset:12',
      checkpoint: null, checkpointAt: null,
      createdAt: '2026-09-30T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    });

    const row = evidence(projectA, g.groupId, {
      sourcePath: 'art/cover.png', destinationPath: 'art/cover.watermarked.png',
    });
    expect(row).toEqual({
      evidenceId: 'id-0002',
      projectId: projectA,
      mutationGroupId: g.groupId,
      operation: 'watermark',
      runId: 'run-1',
      itemKey: 'asset:12',
      assetId: null,
      artifactRole: 'staged-output',
      retentionReason: 'rollback-unresolved',
      artifactPath: '.creatorcrate-watermark-staging/0011aabb.out.png',
      sourcePath: 'art/cover.png',
      destinationPath: 'art/cover.watermarked.png',
      identity: null,
      expectedSize: null,
      expectedSha256: null,
      lifecycle: 'intent',
      observation: 'unchecked',
      observedAt: null,
      createdAt: '2026-09-30T12:00:01.000Z',
      updatedAt: '2026-09-30T12:00:01.000Z',
    });
  });

  it('accepts every in-scope processing operation', () => {
    expect(PROCESSING_RECOVERY_OPERATIONS).toEqual(['workflow-prompt', 'watermark', 'archive', 'convert']);
    for (const operation of PROCESSING_RECOVERY_OPERATIONS) {
      expect(group(projectA, { operation }).operation).toBe(operation);
    }
  });

  it('attaches exact identity later, once, preserving values beyond 2^53 exactly', () => {
    const g = group(projectA);
    const row = evidence(projectA, g.groupId);

    expect(repo.attachEvidenceIdentity(projectA, row.evidenceId, {
      dev: BigInt(BIG_DEV), ino: BIG_INO, birthtimeNs: BigInt(BIG_BIRTH),
    })).toBe(true);
    const attached = repo.findEvidence(projectA, row.evidenceId);
    expect(attached.identity).toEqual({ dev: BIG_DEV, ino: BIG_INO, birthtimeNs: BIG_BIRTH });
    expect(BigInt(attached.identity.ino)).toBe(2n ** 53n + 1n);
    expect(attached.lifecycle).toBe('intent');

    // An established identity is never overwritten.
    expect(repo.attachEvidenceIdentity(projectA, row.evidenceId, { dev: '1', ino: '2' })).toBe(false);
    expect(repo.findEvidence(projectA, row.evidenceId).identity).toEqual({ dev: BIG_DEV, ino: BIG_INO, birthtimeNs: BIG_BIRTH });

    // Identity may also be known at creation; birth time is optional.
    const known = evidence(projectA, g.groupId, { identity: { dev: BIG_DEV, ino: BIG_INO }, lifecycle: 'recovery-critical' });
    expect(known.identity).toEqual({ dev: BIG_DEV, ino: BIG_INO, birthtimeNs: null });
  });

  it('rejects imprecise, unknown, or malformed identity values', () => {
    const g = group(projectA);
    const row = evidence(projectA, g.groupId);
    const bad = [
      { dev: 5, ino: '1' },
      { dev: '1', ino: 2 ** 53 + 2 },
      { dev: 0, ino: 123 },
      { dev: 0, ino: '123' },
      { dev: '1', ino: 0n },
      { dev: '0', ino: '0' },
      { dev: '00', ino: '1' },
      { dev: '0', ino: '0123' },
      { dev: '-1', ino: '1' },
      { dev: '01', ino: '1' },
      { dev: '1.0', ino: '1' },
      { dev: '18446744073709551616', ino: '1' },
      { dev: '1', ino: '1', birthtimeNs: 0n },
      { dev: '1', ino: '1', birthtimeNs: 12 },
      { dev: '1' },
      null,
    ];
    for (const identity of bad) {
      expect(() => repo.attachEvidenceIdentity(projectA, row.evidenceId, identity)).toThrow(InvalidProcessingRecoveryEvidenceError);
    }
    expect(repo.findEvidence(projectA, row.evidenceId).identity).toBeNull();
  });

  it('accepts dev = 0 with a nonzero ino, as the processing ownership contract does', () => {
    const g = group(projectA);
    const fromBigint = evidence(projectA, g.groupId);
    expect(repo.attachEvidenceIdentity(projectA, fromBigint.evidenceId, { dev: 0n, ino: BigInt(BIG_INO) })).toBe(true);
    const attached = repo.findEvidence(projectA, fromBigint.evidenceId).identity;
    expect(attached).toEqual({ dev: '0', ino: BIG_INO, birthtimeNs: null });
    expect(attached.dev).toBe('0');
    expect(attached.ino).toBe(BIG_INO);

    const fromString = evidence(projectA, g.groupId, { identity: { dev: '0', ino: '123' } });
    expect(fromString.identity).toEqual({ dev: '0', ino: '123', birthtimeNs: null });

    const atMax = evidence(projectA, g.groupId, { identity: { dev: '0', ino: '18446744073709551615' } });
    expect(atMax.identity).toEqual({ dev: '0', ino: '18446744073709551615', birthtimeNs: null });
    expect(() => evidence(projectA, g.groupId, { identity: { dev: '0', ino: '18446744073709551616' } }))
      .toThrow(InvalidProcessingRecoveryEvidenceError);
  });

  it('finalizes retention context on the existing row without touching anything else', () => {
    const assetId = insertAsset(projectA, 'art/cover.png');
    const g = group(projectA);
    const row = evidence(projectA, g.groupId, {
      assetId, retentionReason: 'publish-pending', identity: { dev: BIG_DEV, ino: BIG_INO, birthtimeNs: BIG_BIRTH },
    });
    expect(row.retentionReason).toBe('publish-pending');

    expect(repo.setEvidenceRetentionReason(projectA, row.evidenceId, 'rollback-restore-failed')).toBe(true);
    const updated = repo.findEvidence(projectA, row.evidenceId);
    expect(updated).toEqual({ ...row, retentionReason: 'rollback-restore-failed', updatedAt: updated.updatedAt });
    expect(updated.evidenceId).toBe(row.evidenceId);
    expect(updated.mutationGroupId).toBe(g.groupId);
    expect(updated.identity).toEqual({ dev: BIG_DEV, ino: BIG_INO, birthtimeNs: BIG_BIRTH });
    expect(updated.assetId).toBe(assetId);
    expect(updated.createdAt).toBe(row.createdAt);
    expect(updated.updatedAt > row.updatedAt).toBe(true);
    expect(countRows('processing_recovery_evidence')).toBe(1);

    // A later, more accurate reason may replace it again.
    expect(repo.setEvidenceRetentionReason(projectA, row.evidenceId, 'cleanup-failed')).toBe(true);
    expect(repo.findEvidence(projectA, row.evidenceId).retentionReason).toBe('cleanup-failed');

    // Another project cannot change it; absent rows do not report success.
    expect(repo.setEvidenceRetentionReason(projectB, row.evidenceId, 'db-commit-failed')).toBe(false);
    expect(repo.setEvidenceRetentionReason(projectA, 'id-9999', 'db-commit-failed')).toBe(false);

    for (const bad of ['', 'Cleanup Failed', 'cleanup_failed', 'a'.repeat(65), 'free form text', null, 7]) {
      expect(() => repo.setEvidenceRetentionReason(projectA, row.evidenceId, bad)).toThrow(InvalidProcessingRecoveryEvidenceError);
    }
    expect(repo.findEvidence(projectA, row.evidenceId).retentionReason).toBe('cleanup-failed');
  });

  it('links evidence only to an asset of its own project', () => {
    const assetA = insertAsset(projectA, 'art/a.png');
    const assetB = insertAsset(projectB, 'art/b.png');
    const g = group(projectA);

    expect(evidence(projectA, g.groupId, { assetId: assetA }).assetId).toBe(assetA);
    expect(evidence(projectA, g.groupId, { assetId: null }).assetId).toBeNull();
    expect(countRows('processing_recovery_evidence')).toBe(2);

    // Hostile cross-project and nonexistent assets are rejected, not nulled.
    expect(() => evidence(projectA, g.groupId, { assetId: assetB })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => evidence(projectA, g.groupId, { assetId: assetB + 1000 })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(countRows('processing_recovery_evidence')).toBe(2);
    expect(repo.listUnresolvedEvidenceByProject(projectA).map((e) => e.assetId)).toEqual([assetA, null]);
    expect(repo.listUnresolvedEvidenceByProject(projectB)).toEqual([]);
  });

  it('updates lifecycle and observation independently', () => {
    const g = group(projectA);
    const row = evidence(projectA, g.groupId);

    expect(repo.setEvidenceLifecycle(projectA, row.evidenceId, 'recovery-critical')).toBe(true);
    let current = repo.findEvidence(projectA, row.evidenceId);
    expect([current.lifecycle, current.observation, current.observedAt]).toEqual(['recovery-critical', 'unchecked', null]);

    expect(repo.setEvidenceObservation(projectA, row.evidenceId, 'missing')).toBe(true);
    current = repo.findEvidence(projectA, row.evidenceId);
    expect([current.lifecycle, current.observation]).toEqual(['recovery-critical', 'missing']);
    expect(current.observedAt).toBe(current.updatedAt);

    expect(repo.setEvidenceLifecycle(projectA, row.evidenceId, 'dispensable')).toBe(true);
    current = repo.findEvidence(projectA, row.evidenceId);
    expect([current.lifecycle, current.observation]).toEqual(['dispensable', 'missing']);

    expect(repo.setEvidenceObservation(projectA, row.evidenceId, 'unchecked')).toBe(true);
    current = repo.findEvidence(projectA, row.evidenceId);
    expect([current.lifecycle, current.observation, current.observedAt]).toEqual(['dispensable', 'unchecked', null]);
  });

  it('updates expected content proof', () => {
    const g = group(projectA);
    const row = evidence(projectA, g.groupId);
    expect(repo.updateEvidenceContentProof(projectA, row.evidenceId, { expectedSize: 2 ** 40, expectedSha256: SHA })).toBe(true);
    const current = repo.findEvidence(projectA, row.evidenceId);
    expect([current.expectedSize, current.expectedSha256]).toEqual([2 ** 40, SHA]);
    expect(() => repo.updateEvidenceContentProof(projectA, row.evidenceId, { expectedSha256: SHA.toUpperCase() }))
      .toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => repo.updateEvidenceContentProof(projectA, row.evidenceId, { expectedSize: -1 }))
      .toThrow(InvalidProcessingRecoveryEvidenceError);
  });

  it('rejects invalid controlled values and paths before persistence', () => {
    const g = group(projectA);
    const row = evidence(projectA, g.groupId);

    expect(() => group(projectA, { operation: 'cbz' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => group(projectA, { operation: 'Watermark' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => group(projectA, { runId: '' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => group(projectA, { runId: '../run' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => group(0)).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => evidence(projectA, g.groupId, { lifecycle: 'cleaned' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => evidence(projectA, g.groupId, { artifactRole: 'Staged Output' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => evidence(projectA, g.groupId, { retentionReason: '' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => evidence(projectA, g.groupId, { assetId: 1.5 })).toThrow(InvalidProcessingRecoveryEvidenceError);
    for (const artifactPath of [
      '/abs/file.png', 'C:/abs/file.png', 'a\\b.png', '../escape.png', 'a/../b.png', 'a//b.png', './a.png', 'a/', '',
    ]) {
      expect(() => evidence(projectA, g.groupId, { artifactPath })).toThrow(InvalidProcessingRecoveryEvidenceError);
    }
    expect(() => evidence(projectA, g.groupId, { sourcePath: '/etc/passwd' })).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => repo.setEvidenceLifecycle(projectA, row.evidenceId, 'cleaned')).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => repo.setEvidenceObservation(projectA, row.evidenceId, 'gone')).toThrow(InvalidProcessingRecoveryEvidenceError);
    expect(() => repo.markMutationCheckpoint(projectA, g.groupId, 'delete')).toThrow(InvalidProcessingRecoveryEvidenceError);

    expect(countRows('processing_recovery_mutation_groups')).toBe(1);
    expect(countRows('processing_recovery_evidence')).toBe(1);
    const current = repo.findEvidence(projectA, row.evidenceId);
    expect([current.lifecycle, current.observation]).toEqual(['intent', 'unchecked']);
  });

  it('isolates projects for every read and write', () => {
    const gA = group(projectA);
    const gB = group(projectB);
    const rowA = evidence(projectA, gA.groupId);

    expect(repo.findEvidence(projectB, rowA.evidenceId)).toBeNull();
    expect(repo.findMutationGroup(projectB, gA.groupId)).toBeNull();
    expect(repo.listUnresolvedEvidenceByProject(projectB)).toEqual([]);
    expect(repo.listEvidenceByRun(projectB, 'run-1')).toEqual([]);
    expect(repo.listEvidenceByMutationGroup(projectB, gA.groupId)).toEqual([]);
    expect(repo.listMutationGroupsByRun(projectB, 'run-1').map((g) => g.groupId)).toEqual([gB.groupId]);

    expect(repo.attachEvidenceIdentity(projectB, rowA.evidenceId, { dev: '1', ino: '2' })).toBe(false);
    expect(repo.updateEvidenceContentProof(projectB, rowA.evidenceId, { expectedSize: 1 })).toBe(false);
    expect(repo.setEvidenceLifecycle(projectB, rowA.evidenceId, 'dispensable')).toBe(false);
    expect(repo.setEvidenceObservation(projectB, rowA.evidenceId, 'present')).toBe(false);
    expect(repo.setEvidenceRetentionReason(projectB, rowA.evidenceId, 'cleanup-failed')).toBe(false);
    expect(repo.markMutationCheckpoint(projectB, gA.groupId, 'replace')).toBe(false);
    expect(repo.deleteEvidence(projectB, rowA.evidenceId)).toBe(false);
    expect(repo.deleteMutationGroup(projectB, gA.groupId)).toBe(false);

    // Evidence cannot be filed under another project's group.
    expect(() => evidence(projectB, gA.groupId)).toThrow(/FOREIGN KEY/);

    const unchanged = repo.findEvidence(projectA, rowA.evidenceId);
    expect(unchanged).toEqual(rowA);
    expect(repo.findMutationGroup(projectA, gA.groupId)).toEqual(gA);
  });

  it('keeps evidence when its related asset is deleted', () => {
    const assetId = insertAsset(projectA, 'art/cover.png');
    const g = group(projectA);
    const row = evidence(projectA, g.groupId, { assetId });
    expect(row.assetId).toBe(assetId);

    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);

    const current = repo.findEvidence(projectA, row.evidenceId);
    expect(current).toEqual({ ...row, assetId: null });
  });

  it('groups several evidence rows and persists the checkpoint independently of identity', () => {
    const g1 = group(projectA, { runId: 'run-1', itemKey: 'asset:1' });
    const g2 = group(projectA, { runId: 'run-1', itemKey: 'asset:2' });
    const other = group(projectA, { runId: 'run-2', operation: 'convert' });
    const staged = evidence(projectA, g1.groupId, { artifactRole: 'staged-output' });
    const backup = evidence(projectA, g1.groupId, { artifactRole: 'replaced-original', artifactPath: '.creatorcrate-watermark-staging/0011aabb.backup.png' });
    const second = evidence(projectA, g2.groupId);
    evidence(projectA, other.groupId, { artifactPath: '.creatorcrate-convert-staging/ff.out.webp' });

    // Checkpoint before any artifact has an established identity.
    expect(repo.markMutationCheckpoint(projectA, g1.groupId, 'replace')).toBe(true);
    const checkpointed = repo.findMutationGroup(projectA, g1.groupId);
    expect(checkpointed.checkpoint).toBe('replace');
    expect(checkpointed.checkpointAt).toBe(checkpointed.updatedAt);
    expect(repo.listEvidenceByMutationGroup(projectA, g1.groupId).map((e) => [e.evidenceId, e.identity]))
      .toEqual([[staged.evidenceId, null], [backup.evidenceId, null]]);

    expect(repo.listEvidenceByRun(projectA, 'run-1').map((e) => e.evidenceId))
      .toEqual([staged.evidenceId, backup.evidenceId, second.evidenceId]);
    expect(repo.listMutationGroupsByRun(projectA, 'run-1').map((g) => g.groupId)).toEqual([g1.groupId, g2.groupId]);
    expect(repo.listMutationGroupsByProject(projectA).map((g) => g.groupId))
      .toEqual([g1.groupId, g2.groupId, other.groupId]);

    // Advancing to a later checkpoint overwrites; clearing is explicit.
    expect(repo.markMutationCheckpoint(projectA, g1.groupId, 'restore')).toBe(true);
    expect(repo.findMutationGroup(projectA, g1.groupId).checkpoint).toBe('restore');
    expect(repo.clearMutationCheckpoint(projectA, g1.groupId)).toBe(true);
    expect(repo.clearMutationCheckpoint(projectA, g1.groupId)).toBe(false);
    expect(repo.findMutationGroup(projectA, g1.groupId)).toMatchObject({ checkpoint: null, checkpointAt: null });

    // A checkpoint on a group with no evidence at all still persists.
    const bare = group(projectA, { runId: 'run-3' });
    expect(repo.markMutationCheckpoint(projectA, bare.groupId, 'public-create')).toBe(true);
    expect(repo.findMutationGroup(projectA, bare.groupId).checkpoint).toBe('public-create');
  });

  it('persists groups, checkpoints, evidence, and exact identity across reopen', () => {
    const g = group(projectA);
    repo.markMutationCheckpoint(projectA, g.groupId, 'unlink');
    const row = evidence(projectA, g.groupId, {
      identity: { dev: BIG_DEV, ino: BIG_INO, birthtimeNs: BIG_BIRTH },
      lifecycle: 'recovery-critical',
      expectedSize: 10,
      expectedSha256: SHA,
    });
    const savedGroup = repo.findMutationGroup(projectA, g.groupId);

    closeDatabase(db);
    open();

    expect(repo.findEvidence(projectA, row.evidenceId)).toEqual(row);
    expect(repo.findMutationGroup(projectA, g.groupId)).toEqual(savedGroup);
    expect(repo.listUnresolvedEvidenceByProject(projectA)).toEqual([row]);
  });

  it('deletes only the intended evidence row and never prunes implicitly', () => {
    const g = group(projectA);
    const keep = evidence(projectA, g.groupId);
    const cleaned = evidence(projectA, g.groupId, { artifactPath: '.creatorcrate-watermark-staging/x.png' });
    const gB = group(projectB);
    const other = evidence(projectB, gB.groupId);
    for (const row of [keep, cleaned]) {
      repo.setEvidenceLifecycle(projectA, row.evidenceId, 'dispensable');
      repo.setEvidenceObservation(projectA, row.evidenceId, 'missing');
    }

    // Dispensable/missing rows remain until an explicit caller deletes them.
    expect(repo.listUnresolvedEvidenceByProject(projectA).map((e) => e.evidenceId))
      .toEqual([keep.evidenceId, cleaned.evidenceId]);

    // A group with remaining evidence cannot be removed.
    expect(repo.deleteMutationGroup(projectA, g.groupId)).toBe(false);

    expect(repo.deleteEvidence(projectA, cleaned.evidenceId)).toBe(true);
    expect(repo.deleteEvidence(projectA, cleaned.evidenceId)).toBe(false);
    expect(repo.findEvidence(projectA, cleaned.evidenceId)).toBeNull();
    expect(repo.listUnresolvedEvidenceByProject(projectA).map((e) => e.evidenceId)).toEqual([keep.evidenceId]);
    expect(repo.findEvidence(projectB, other.evidenceId)).toEqual(other);
    expect(repo.findMutationGroup(projectA, g.groupId)).not.toBeNull();

    // Once its last evidence is resolved, the group itself goes only on request.
    expect(repo.deleteEvidence(projectA, keep.evidenceId)).toBe(true);
    expect(repo.findMutationGroup(projectA, g.groupId)).not.toBeNull();
    expect(repo.deleteMutationGroup(projectA, g.groupId)).toBe(true);
    expect(repo.findMutationGroup(projectA, g.groupId)).toBeNull();
    expect(countRows('processing_recovery_evidence')).toBe(1);
    expect(countRows('processing_recovery_mutation_groups')).toBe(1);
  });

  it('lists all unresolved lifecycles for the project, oldest first', () => {
    const g = group(projectA);
    const intent = evidence(projectA, g.groupId);
    const critical = evidence(projectA, g.groupId, { lifecycle: 'recovery-critical' });
    const dispensable = evidence(projectA, g.groupId, { lifecycle: 'dispensable' });
    expect(repo.listUnresolvedEvidenceByProject(projectA).map((e) => [e.evidenceId, e.lifecycle])).toEqual([
      [intent.evidenceId, 'intent'],
      [critical.evidenceId, 'recovery-critical'],
      [dispensable.evidenceId, 'dispensable'],
    ]);
  });

  it('participates in the caller transaction on the same connection', () => {
    const g = group(projectA);
    const assetId = insertAsset(projectA, 'art/cover.png');

    const failing = db.transaction(() => {
      evidence(projectA, g.groupId, { assetId });
      repo.markMutationCheckpoint(projectA, g.groupId, 'public-create');
      db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('renamed.png', assetId);
      throw new Error('abort');
    });
    expect(() => failing()).toThrow('abort');
    expect(repo.listUnresolvedEvidenceByProject(projectA)).toEqual([]);
    expect(repo.findMutationGroup(projectA, g.groupId).checkpoint).toBeNull();
    expect(db.prepare('SELECT filename FROM assets WHERE id = ?').pluck().get(assetId)).toBe('cover.png');

    const committed = db.transaction(() => {
      const row = evidence(projectA, g.groupId, { assetId });
      repo.setEvidenceLifecycle(projectA, row.evidenceId, 'dispensable');
      db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('renamed.png', assetId);
      return row.evidenceId;
    })();
    expect(repo.findEvidence(projectA, committed).lifecycle).toBe('dispensable');
    expect(db.prepare('SELECT filename FROM assets WHERE id = ?').pluck().get(assetId)).toBe('renamed.png');
  });
});
