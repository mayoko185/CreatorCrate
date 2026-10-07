import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createProcessingRecoveryRouter } from '../src/routes/processing-recovery.js';
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { createProcessingRecoveryGateRepository } from '../src/data/processing-recovery-gate-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createProcessingRecoveryEvidenceService } from '../src/services/processing-recovery-evidence-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingJobService } from '../src/services/processing-job-service.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';
import { deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PRIVATE_PATH = '.creatorcrate-convert-staging/0123456789abcdef.0.output';
const url = (id, action = '') => `/projects/${id}/assets/processing/recovery${action ? `/${action}` : ''}`;

async function captureFsCalls(action) {
  const calls = [];
  const spies = [];
  for (const [target, prefix] of [[fs, 'fs'], [fs.promises, 'fs.promises']]) {
    for (const name of Object.keys(target)) {
      if (typeof target[name] !== 'function' || /^[A-Z]/.test(name)) continue;
      const original = target[name];
      spies.push(vi.spyOn(target, name).mockImplementation(function (...args) {
        calls.push(`${prefix}.${name}`);
        return original.apply(this, args);
      }));
    }
  }
  try {
    return { response: await action(), calls };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

describe('Recovery Details HTTP API', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let repository;
  let gate;
  let coordinator;
  let projectRepository;
  let service;
  let services;
  let app;
  let projectA;
  let projectB;
  let clock;
  let sequence;

  function insertProject(slug) {
    const id = Number(db.prepare(`INSERT INTO projects (title, slug, status, project_type)
      VALUES (?, ?, 'tbd', 'images')`).run(slug, slug).lastInsertRowid);
    const relative = `${String(id).padStart(6, '0')}-${slug}`;
    db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(relative, id);
    const dir = path.join(projectsRoot, relative);
    fs.mkdirSync(dir, { recursive: true });
    bindTestProjectOwnership(db, id, dir);
    return { id, dir };
  }

  function addGroup(project = projectA, checkpoint = null) {
    const group = repository.createMutationGroup({
      projectId: project.id, operation: 'convert', runId: 'run-recovery', itemKey: 'Final/source.png',
    });
    if (checkpoint) repository.markMutationCheckpoint(project.id, group.groupId, checkpoint);
    return repository.findMutationGroup(project.id, group.groupId);
  }

  function addEvidence(project = projectA, { group = addGroup(project), ...overrides } = {}) {
    return repository.createEvidence({
      projectId: project.id, mutationGroupId: group.groupId, artifactRole: 'stage-output',
      retentionReason: 'residue', artifactPath: PRIVATE_PATH,
      sourcePath: 'Final/source.png', destinationPath: 'Final/source.webp',
      identity: { dev: '0', ino: '9007199254740993', birthtimeNs: '1727654400123456789' },
      expectedSize: 5, expectedSha256: 'ab'.repeat(32), lifecycle: 'dispensable',
      ...overrides,
    });
  }

  function addRealEvidence() {
    const target = path.join(projectA.dir, ...PRIVATE_PATH.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stage');
    const stats = fs.lstatSync(target, { bigint: true });
    const row = addEvidence(projectA, {
      identity: { dev: stats.dev, ino: stats.ino }, expectedSize: 5,
      expectedSha256: createHash('sha256').update('stage').digest('hex'),
    });
    return { row, target };
  }

  function buildRouter(filesystemService = services) {
    const instance = express();
    instance.use(express.json());
    instance.use('/projects', createProcessingRecoveryRouter({
      projectService: projectRepository, processingRecoveryEvidenceRepository: repository,
      processingRecoveryGate: gate, processingRecoveryEvidenceService: filesystemService,
    }));
    return instance;
  }

  function snapshot() {
    return {
      groups: db.prepare('SELECT * FROM processing_recovery_mutation_groups ORDER BY group_id').all(),
      evidence: db.prepare('SELECT * FROM processing_recovery_evidence ORDER BY evidence_id').all(),
      gate: db.prepare("SELECT * FROM app_meta WHERE key GLOB 'processing.recovery_required.*' ORDER BY key").all(),
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-recovery-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    clock = 0;
    sequence = 0;
    repository = createProcessingRecoveryEvidenceRepository(db, {
      now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, clock++)),
      generateId: () => `id-${String(sequence++).padStart(4, '0')}`,
    });
    projectRepository = createProjectRepository(db);
    projectA = insertProject('project-a');
    projectB = insertProject('project-b');
    gate = createProcessingRecoveryGateRepository(db);
    coordinator = createProjectOperationCoordinator();
    service = createProcessingRecoveryEvidenceService({
      db, repository, projectRepository, projectsRoot, projectOperationCoordinator: coordinator,
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
    });
    services = {
      refreshEvidence: vi.fn((...args) => service.refreshEvidence(...args)),
      cleanupEvidence: vi.fn((...args) => service.cleanupEvidence(...args)),
    };
    app = buildRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET returns safe evidence with group context and the independent gate, without changing SQLite', async () => {
    const group = addGroup(projectA, 'replace');
    const row = addEvidence(projectA, { group, assetId: null });
    gate.markRecoveryRequired(projectA.id);
    const before = snapshot();
    const response = await request(app).get(url(projectA.id)).expect(200);
    expect(response.body).toEqual({ ok: true, recoveryRequired: true, entries: [{
      kind: 'evidence', evidenceId: row.evidenceId, projectId: projectA.id, assetId: null,
      operation: 'convert', runId: group.runId, mutationGroupId: group.groupId, itemKey: group.itemKey,
      checkpoint: 'replace', checkpointAt: group.checkpointAt,
      artifactRole: 'stage-output', lifecycle: 'dispensable', observation: 'unchecked', observedAt: null,
      retentionReason: 'residue', artifactPath: PRIVATE_PATH,
      sourcePath: 'Final/source.png', destinationPath: 'Final/source.webp',
      identityRecorded: true, contentProofRecorded: true, createdAt: row.createdAt, updatedAt: row.updatedAt,
      artifactClass: 'private', cleanupPolicyEligible: true,
    }] });
    expect(response.text).not.toContain(projectA.dir);
    expect(response.text).not.toContain('9007199254740993');
    expect(response.text).not.toContain('1727654400123456789');
    expect(response.body.entries[0]).not.toHaveProperty('identity');
    expect(response.body.entries[0]).not.toHaveProperty('expectedSha256');
    expect(snapshot()).toEqual(before);
    expect(services.refreshEvidence).not.toHaveBeenCalled();
    expect(services.cleanupEvidence).not.toHaveBeenCalled();
  });

  it('GET keeps actionable evidence when the recovery gate is clear', async () => {
    const row = addEvidence();
    const response = await request(app).get(url(projectA.id)).expect(200);
    expect(response.body.recoveryRequired).toBe(false);
    expect(response.body.entries.map((entry) => entry.evidenceId)).toEqual([row.evidenceId]);
  });

  it('GET includes only checkpointed empty groups, without inventing artifacts or writing state', async () => {
    const unresolved = addGroup(projectA, 'unlink');
    addGroup();
    const represented = addGroup(projectA, 'restore');
    const row = addEvidence(projectA, { group: represented });
    const before = snapshot();
    const response = await request(app).get(url(projectA.id)).expect(200);
    expect(response.body.entries).toEqual([
      {
        kind: 'mutation-group', mutationGroupId: unresolved.groupId, operation: 'convert',
        runId: unresolved.runId, itemKey: unresolved.itemKey, checkpoint: 'unlink',
        checkpointAt: unresolved.checkpointAt, createdAt: unresolved.createdAt, updatedAt: unresolved.updatedAt,
        evidenceCount: 0,
      },
      expect.objectContaining({ kind: 'evidence', evidenceId: row.evidenceId, checkpoint: 'restore' }),
    ]);
    expect(snapshot()).toEqual(before);
  });

  it('GET isolates both evidence and empty checkpoint groups by project', async () => {
    const own = addEvidence();
    addEvidence(projectB);
    addGroup(projectB, 'public-create');
    gate.markRecoveryRequired(projectB.id);
    const response = await request(app).get(url(projectA.id)).expect(200);
    expect(response.body.recoveryRequired).toBe(false);
    expect(response.body.entries).toEqual([expect.objectContaining({ evidenceId: own.evidenceId })]);
  });

  it('GET makes zero filesystem calls, including open/hash reads, directory reads and JSON reads', async () => {
    addRealEvidence();
    addGroup(projectA, 'replace');
    const { response, calls } = await captureFsCalls(() => request(app).get(url(projectA.id)));
    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(services.refreshEvidence).not.toHaveBeenCalled();
  });

  it('GET orders combined entries by creation timestamp, then kind and ID, regardless of refresh timestamps', async () => {
    const earlyGroup = addGroup(projectA, 'replace');
    const first = addEvidence();
    const second = addEvidence();
    const tiedGroup = addGroup(projectA, 'restore');
    db.prepare('UPDATE processing_recovery_evidence SET created_at = ? WHERE evidence_id = ?')
      .run(first.createdAt, second.evidenceId);
    db.prepare('UPDATE processing_recovery_mutation_groups SET created_at = ? WHERE group_id = ?')
      .run(first.createdAt, tiedGroup.groupId);
    const response = await request(app).get(url(projectA.id)).expect(200);
    const ids = (res) => res.body.entries.map((entry) => entry.evidenceId ?? entry.mutationGroupId);
    expect(ids(response)).toEqual([earlyGroup.groupId, first.evidenceId, second.evidenceId, tiedGroup.groupId]);
    await request(app).post(url(projectA.id, 'refresh')).send({ evidenceIds: [first.evidenceId] }).expect(200);
    expect(ids(await request(app).get(url(projectA.id)).expect(200))).toEqual(ids(response));
  });

  it.each(['status', 'archived_at'])('archived projects stay GET-readable and reject both POSTs (%s)', async (field) => {
    const row = addEvidence();
    db.prepare(`UPDATE projects SET ${field} = ? WHERE id = ?`)
      .run(field === 'status' ? 'archived' : '2026-10-02T12:00:00Z', projectA.id);
    expect((await request(app).get(url(projectA.id)).expect(200)).body.entries).toHaveLength(1);
    const before = snapshot();
    for (const action of ['refresh', 'cleanup']) {
      const response = await request(app).post(url(projectA.id, action)).send({ evidenceIds: [row.evidenceId] }).expect(409);
      expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
    }
    expect(services.refreshEvidence).not.toHaveBeenCalled();
    expect(services.cleanupEvidence).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('empty-string archived_at uses the canonical archived policy: GET-readable, both POSTs rejected before services or fs', async () => {
    const { row, target } = addRealEvidence();
    db.prepare("UPDATE projects SET archived_at = '', status = 'tbd' WHERE id = ?").run(projectA.id);
    expect((await request(app).get(url(projectA.id)).expect(200)).body.entries).toHaveLength(1);
    // Warm the JSON body parser's lazy module loads so captured fs calls reflect only route/service work.
    await request(app).post(url(999, 'refresh')).send({ evidenceIds: [row.evidenceId] }).expect(404);
    const before = snapshot();
    const run = vi.spyOn(coordinator, 'runAsync');
    for (const action of ['refresh', 'cleanup']) {
      const { response, calls } = await captureFsCalls(() => request(app).post(url(projectA.id, action))
        .send({ evidenceIds: [row.evidenceId] }));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
      expect(calls).toEqual([]);
    }
    expect(services.refreshEvidence).not.toHaveBeenCalled();
    expect(services.cleanupEvidence).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(target)).toBe(true);
    expect(repository.findEvidence(projectA.id, row.evidenceId)).not.toBeNull();

    // Active control: archived_at NULL with a non-archived status reaches both reviewed services.
    db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(projectA.id);
    await request(app).post(url(projectA.id, 'refresh')).send({ evidenceIds: [row.evidenceId] }).expect(200);
    await request(app).post(url(projectA.id, 'cleanup')).send({ evidenceIds: [row.evidenceId] }).expect(200);
    expect(services.refreshEvidence).toHaveBeenCalledExactlyOnceWith(projectA.id, [row.evidenceId]);
    expect(services.cleanupEvidence).toHaveBeenCalledExactlyOnceWith(projectA.id, [row.evidenceId]);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['', 'refresh', 'cleanup'])('returns controlled project lookup errors (%s)', async (action) => {
    for (const [id, status, code] of [['0', 400, 'INVALID_REQUEST'], ['9007199254740992', 400, 'INVALID_REQUEST'], ['999', 404, 'PROJECT_NOT_FOUND']]) {
      const http = action ? request(app).post(url(id, action)).send({ evidenceIds: ['id-0001'] }) : request(app).get(url(id));
      expect((await http.expect(status)).body.error.code).toBe(code);
    }
  });

  it('refresh delegates only normalized IDs and returns advisory observations without changing lifecycle, gate or checkpoint', async () => {
    const { row } = addRealEvidence();
    gate.markRecoveryRequired(projectA.id);
    repository.markMutationCheckpoint(projectA.id, row.mutationGroupId, 'replace');
    const before = snapshot();
    const response = await request(app).post(url(projectA.id, 'refresh'))
      .send({ evidenceIds: [row.evidenceId, row.evidenceId] }).expect(200);
    expect(services.refreshEvidence).toHaveBeenCalledExactlyOnceWith(projectA.id, [row.evidenceId]);
    expect(response.body.results).toEqual([expect.objectContaining({
      evidenceId: row.evidenceId, observation: 'present', lifecycle: 'dispensable', checkpoint: 'replace',
    })]);
    expect(response.body.results[0]).not.toHaveProperty('identity');
    const after = snapshot();
    expect(after.groups).toEqual(before.groups);
    expect(after.gate).toEqual(before.gate);
    expect(after.evidence[0].lifecycle).toBe(before.evidence[0].lifecycle);
    expect(after.evidence[0].observation).toBe('present');
    expect(after.evidence[0].observed_at).not.toBeNull();
  });

  it('refresh reports unavailable observation when the registered project filesystem cannot be proved', async () => {
    const row = addEvidence();
    fs.rmSync(projectA.dir, { recursive: true, force: true });
    const response = await request(app).post(url(projectA.id, 'refresh')).send({ evidenceIds: [row.evidenceId] }).expect(200);
    expect(response.body.results[0].observation).toBe('unavailable');
    expect(repository.findEvidence(projectA.id, row.evidenceId).observation).toBe('unavailable');
    expect(response.text).not.toContain(projectA.dir);
  });

  it.each(['refresh', 'cleanup'])('%s rejects foreign, nonexistent and group-only IDs before all filesystem access', async (action) => {
    const own = addEvidence();
    const foreign = addEvidence(projectB);
    const group = addGroup(projectA, 'replace');
    const before = snapshot();
    const bodies = [];
    for (const id of [foreign.evidenceId, 'nonexistent-evidence', group.groupId]) {
      const { response, calls } = await captureFsCalls(() => request(app).post(url(projectA.id, action))
        .send({ evidenceIds: [own.evidenceId, id] }));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RECOVERY_EVIDENCE_NOT_FOUND');
      expect(calls).toEqual([]);
      bodies.push(response.body);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(snapshot()).toEqual(before);
  });

  it.each(['refresh', 'cleanup'])('%s validates strict evidence-only bodies, ID format, empty and excessive lists', async (action) => {
    const row = addEvidence();
    const before = snapshot();
    const invalidBodies = [
      {}, [], { evidenceIds: null }, { evidenceIds: 'id-1' }, { evidenceIds: [] },
      { evidenceIds: [1] }, { evidenceIds: ['../file'] }, { evidenceIds: ['a'.repeat(129)] },
      { evidenceIds: [''] }, { evidenceIds: [null] }, { evidenceIds: [{}] },
      { evidenceIds: ['id-1\n'] }, { evidenceIds: Array(1001).fill(row.evidenceId) },
      ...['path', 'paths', 'artifactPath', 'role', 'identity', 'observation', 'lifecycle', 'cleanupPolicyEligible', 'mutationGroupId', 'checkpoint', 'constructor', '__proto__']
        .map((key) => JSON.parse(`{"evidenceIds":["${row.evidenceId}"],"${key}":"caller-value"}`)),
    ];
    for (const body of invalidBodies) {
      const response = await request(app).post(url(projectA.id, action)).type('json').send(JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_REQUEST');
    }
    expect(services.refreshEvidence).not.toHaveBeenCalled();
    expect(services.cleanupEvidence).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it.each(['refresh', 'cleanup'])('%s permits 1000 IDs and the full repository opaque-ID format', async (action) => {
    const method = `${action}Evidence`;
    services[method].mockResolvedValue([]);
    const ids = Array.from({ length: 1000 }, (_, index) => `id._:${index}`);
    const response = await request(app).post(url(projectA.id, action)).send({ evidenceIds: ids }).expect(200);
    expect(response.body).toEqual({ ok: true, results: [] });
    expect(services[method]).toHaveBeenCalledExactlyOnceWith(projectA.id, ids);
  });

  it('cleanup delegates to reviewed fresh proof, removes only proven private residue and preserves the gate', async () => {
    const { row, target } = addRealEvidence();
    const unresolved = addGroup(projectA, 'unlink');
    gate.markRecoveryRequired(projectA.id);
    const before = snapshot();
    const run = vi.spyOn(coordinator, 'runAsync');
    const response = await request(app).post(url(projectA.id, 'cleanup'))
      .send({ evidenceIds: [row.evidenceId, row.evidenceId] }).expect(200);
    expect(services.cleanupEvidence).toHaveBeenCalledExactlyOnceWith(projectA.id, [row.evidenceId]);
    expect(run).toHaveBeenCalledExactlyOnceWith(projectA.id, expect.any(Function));
    expect(response.body.results).toEqual([{
      evidenceId: row.evidenceId, artifactPath: PRIVATE_PATH, status: 'cleaned', reason: 'removed', observation: 'missing',
    }]);
    expect(fs.existsSync(target)).toBe(false);
    expect(repository.findEvidence(projectA.id, row.evidenceId)).toBeNull();
    expect(repository.findMutationGroup(projectA.id, unresolved.groupId)).toEqual(unresolved);
    expect(snapshot().gate).toEqual(before.gate);
  });

  it.each(['published-output', 'originals-copy'])('cleanup preserves blocked public result and never touches %s', async (artifactRole) => {
    const row = addEvidence(projectA, { artifactRole, artifactPath: 'Final/originals/source.png' });
    gate.markRecoveryRequired(projectA.id);
    const before = snapshot();
    const { response, calls } = await captureFsCalls(() => request(app).post(url(projectA.id, 'cleanup'))
      .send({ evidenceIds: [row.evidenceId] }));
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([{
      evidenceId: row.evidenceId, artifactPath: row.artifactPath, status: 'blocked', reason: 'public-tracking', observation: 'unchecked',
    }]);
    expect(services.cleanupEvidence).toHaveBeenCalledExactlyOnceWith(projectA.id, [row.evidenceId]);
    expect(calls).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('cleanup cannot clear checkpoints or transition lifecycle for recovery-critical or checkpointed evidence', async () => {
    const critical = addEvidence(projectA, { lifecycle: 'recovery-critical' });
    const checkpointed = addEvidence(projectA, { group: addGroup(projectA, 'replace') });
    gate.markRecoveryRequired(projectA.id);
    const before = snapshot();
    const { response, calls } = await captureFsCalls(() => request(app).post(url(projectA.id, 'cleanup'))
      .send({ evidenceIds: [critical.evidenceId, checkpointed.evidenceId] }));
    expect(response.status).toBe(200);
    expect(response.body.results.map((row) => [row.status, row.reason]))
      .toEqual([['blocked', 'recovery-critical'], ['blocked', 'checkpoint-active']]);
    expect(calls).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it.each(['refresh', 'cleanup'])('%s cannot request direct group/checkpoint deletion', async (action) => {
    const group = addGroup(projectA, 'replace');
    const row = addEvidence();
    const before = snapshot();
    await request(app).post(url(projectA.id, action)).send({ mutationGroupId: group.groupId }).expect(400);
    await request(app).post(url(projectA.id, action))
      .send({ evidenceIds: [row.evidenceId], mutationGroupId: group.groupId, checkpoint: null }).expect(400);
    await request(app).delete(`${url(projectA.id)}/${group.groupId}`).expect(404);
    expect(snapshot()).toEqual(before);
  });

  it('cleanup persistence failure is controlled JSON, retains metadata and never exposes raw filesystem/SQLite errors', async () => {
    const { row, target } = addRealEvidence();
    gate.markRecoveryRequired(projectA.id);
    const before = snapshot();
    vi.spyOn(repository, 'deleteEvidence').mockImplementation(() => { throw new Error(`SQLITE ${target}`); });
    const response = await request(app).post(url(projectA.id, 'cleanup')).send({ evidenceIds: [row.evidenceId] }).expect(500);
    expect(response.body.error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
    expect(response.text).not.toContain('SQLITE');
    expect(response.text).not.toContain(target);
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refresh persistence and unexpected infrastructure errors use safe JSON failures', async () => {
    const row = addEvidence();
    vi.spyOn(repository, 'setEvidenceObservation').mockImplementation(() => { throw new Error(`SQLITE ${projectA.dir}`); });
    const response = await request(app).post(url(projectA.id, 'refresh')).send({ evidenceIds: [row.evidenceId] }).expect(500);
    expect(response.body).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
    expect(repository.findEvidence(projectA.id, row.evidenceId).observation).toBe('unchecked');
    services.cleanupEvidence.mockRejectedValue(new Error(`EACCES ${projectA.dir}`));
    expect((await request(app).post(url(projectA.id, 'cleanup')).send({ evidenceIds: [row.evidenceId] }).expect(500)).body)
      .toEqual(response.body);
    vi.spyOn(repository, 'listMutationGroupsByProject').mockImplementation(() => { throw new Error('SQLITE secret'); });
    expect((await request(app).get(url(projectA.id)).expect(500)).body).toEqual(response.body);
  });

  it('refresh remains unlocked during an active job; cleanup waits for its shared coordinator', async () => {
    const row = addEvidence(projectA, { artifactRole: 'originals-copy', artifactPath: 'Final/originals/source.png' });
    let releaseJob;
    const wait = new Promise((resolve) => { releaseJob = resolve; });
    const jobs = createProcessingJobService({ projectOperationCoordinator: coordinator });
    const jobId = jobs.enqueue({ projectId: projectA.id, execute: () => wait });
    let cleanup;
    try {
      expect(jobs.hasActiveJobs()).toBe(true);
      expect(coordinator.isActive(projectA.id)).toBe(true);
      await request(app).post(url(projectA.id, 'refresh')).send({ evidenceIds: [row.evidenceId] }).expect(200);
      const find = vi.spyOn(repository, 'findEvidence');
      let submitted;
      const reachedService = new Promise((resolve) => { submitted = resolve; });
      services.cleanupEvidence.mockImplementation((...args) => {
        const result = service.cleanupEvidence(...args);
        submitted();
        return result;
      });
      cleanup = request(app).post(url(projectA.id, 'cleanup')).send({ evidenceIds: [row.evidenceId] }).then((res) => res);
      await reachedService;
      expect(find).not.toHaveBeenCalled();
      expect(jobs.getJob(jobId).state).toBe('running');
      releaseJob();
      await jobs.waitForIdle();
      const response = await cleanup;
      expect(response.status).toBe(200);
      expect(response.body.results[0].status).toBe('blocked');
      expect(find).toHaveBeenCalled();
    } finally {
      releaseJob();
      await jobs.waitForIdle();
      if (cleanup) await cleanup;
    }
  });

  it('cleanup maps a synchronous coordinator conflict to 409', async () => {
    const row = addEvidence();
    services.cleanupEvidence.mockImplementation((...args) => {
      let result;
      coordinator.run(projectA.id, () => { result = service.cleanupEvidence(...args); });
      return result;
    });
    const response = await request(app).post(url(projectA.id, 'cleanup')).send({ evidenceIds: [row.evidenceId] }).expect(409);
    expect(response.body.error.code).toBe('PROJECT_OPERATION_IN_PROGRESS');
  });

  it('rootless router GET is DB-readable and both POSTs report filesystem service unavailable', async () => {
    const row = addEvidence();
    addGroup(projectA, 'replace');
    app = buildRouter(null);
    const { response, calls } = await captureFsCalls(() => request(app).get(url(projectA.id)));
    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(2);
    expect(calls).toEqual([]);
    for (const action of ['refresh', 'cleanup']) {
      const result = await request(app).post(url(projectA.id, action)).send({ evidenceIds: [row.evidenceId] }).expect(503);
      expect(result.body.error.code).toBe('PROCESSING_RECOVERY_UNAVAILABLE');
    }
  });

  it('routes contain no filesystem cleanup/proof, directory inventory or JSON-file logic', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../src/routes/processing-recovery.js', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/node:fs|owned-file|owned-path-content|resolveContainedAssetPath|\b(?:unlink|stat|lstat|readFile|readdir|opendir|createReadStream)(?:Sync)?\s*\(/);
    expect(source).not.toMatch(/clearMutationCheckpoint|deleteMutationGroup|clearRecoveryRequired|setEvidenceLifecycle/);
  });

  describe('real app registration and request protection', () => {
    function fullApp({ rooted = true, ...opts } = {}) {
      return createApp(
        { appName: 'CreatorCrate', db, ...(rooted ? { projectsRoot } : {}) },
        { appDataRoot: tmpDir, ...opts },
      );
    }

    it.each([true, false])('registered GET makes zero fs calls with rooted=%s', async (rooted) => {
      const row = addEvidence();
      addGroup(projectA, 'unlink');
      const instance = fullApp({ rooted });
      const { response, calls } = await captureFsCalls(() => request(instance).get(url(projectA.id)));
      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(2);
      expect(response.body.entries[0].evidenceId).toBe(row.evidenceId);
      expect(calls).toEqual([]);
      expect(Boolean(instance.locals.processingRecoveryEvidenceService)).toBe(rooted);
    });

    it('rootless app registers POSTs and safely returns unavailable', async () => {
      const row = addEvidence();
      const instance = fullApp({ rooted: false });
      for (const action of ['refresh', 'cleanup']) {
        const { response, calls } = await captureFsCalls(() => request(instance).post(url(projectA.id, action))
          .send({ evidenceIds: [row.evidenceId] }));
        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('PROCESSING_RECOVERY_UNAVAILABLE');
        expect(calls).toEqual([]);
      }
    });

    it('real app delegates refresh and cleanup through its wired service and coordinator', async () => {
      const { row, target } = addRealEvidence();
      const run = vi.spyOn(coordinator, 'runAsync');
      const instance = fullApp({ projectOperationCoordinator: coordinator });
      const refresh = await request(instance).post(url(projectA.id, 'refresh')).send({ evidenceIds: [row.evidenceId] }).expect(200);
      expect(refresh.body.results[0].observation).toBe('present');
      const cleanup = await request(instance).post(url(projectA.id, 'cleanup')).send({ evidenceIds: [row.evidenceId] }).expect(200);
      expect(cleanup.body.results[0].status).toBe('cleaned');
      expect(run).toHaveBeenCalledExactlyOnceWith(projectA.id, expect.any(Function));
      expect(fs.existsSync(target)).toBe(false);
    });

    it('auth protects GET and POST; session CSRF headers protect both mutations', async () => {
      const row = addEvidence(projectA, { artifactRole: 'originals-copy', artifactPath: 'Final/originals/source.png' });
      const instance = fullApp({ authConfig: AUTH_CONFIG });
      await request(instance).get(url(projectA.id)).set('Accept', 'application/json').expect(401);
      for (const action of ['refresh', 'cleanup']) {
        await request(instance).post(url(projectA.id, action)).send({ evidenceIds: [row.evidenceId] }).expect(401);
      }
      const { agent, csrfToken } = await authenticate(instance);
      const { response, calls } = await captureFsCalls(() => agent.get(url(projectA.id)));
      expect(response.status).toBe(200);
      expect(calls).toEqual([]);
      for (const action of ['refresh', 'cleanup']) {
        await agent.post(url(projectA.id, action)).send({ evidenceIds: [row.evidenceId] }).expect(403);
        await agent.post(url(projectA.id, action)).set('X-CSRF-Token', 'invalid').send({ evidenceIds: [row.evidenceId] }).expect(403);
        await agent.post(url(projectA.id, action)).set('X-CSRF-Token', csrfToken).send({ evidenceIds: [row.evidenceId] }).expect(200);
      }
    });

    it('disabled-auth mode still requires the normal visitor CSRF header', async () => {
      const row = addEvidence(projectA, { artifactRole: 'originals-copy', artifactPath: 'Final/originals/source.png' });
      const csrfPepper = 'a'.repeat(64);
      const instance = fullApp({ authState: { csrfPepper } });
      const agent = request.agent(instance);
      const { response, calls } = await captureFsCalls(() => agent.get(url(projectA.id)));
      expect(response.status).toBe(200);
      expect(calls).toEqual([]);
      const cookie = response.headers['set-cookie'].find((value) => value.startsWith('cc_csrf_anon='));
      const secret = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
      const token = deriveDisabledModeCsrfToken(csrfPepper, secret);
      for (const action of ['refresh', 'cleanup']) {
        await agent.post(url(projectA.id, action)).send({ evidenceIds: [row.evidenceId] }).expect(403);
        await agent.post(url(projectA.id, action)).set('X-CSRF-Token', token).send({ evidenceIds: [row.evidenceId] }).expect(200);
      }
    });
  });
});
